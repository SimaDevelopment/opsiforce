package server

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/bufferpool"
	"opsiforce/proxy/internal/config"
	"opsiforce/proxy/internal/proxycache"
	"opsiforce/proxy/internal/requestlog"
)

var projectIDPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// promptSendPattern matches the opencode upstream path a user Prompt send
// crosses: POST /api/session/{id}/prompt. It is the single coupling point to
// opencode's naming; if that path is renamed the sidebar silently stops
// reordering, so the classification lives here alone.
var promptSendPattern = regexp.MustCompile(`^/api/session/[^/]+/prompt$`)

const environmentIDLength = 36

const (
	retryAfterHeader         = "Retry-After"
	restartRetryAfterSeconds = "5"
)

var (
	restartingBody = []byte(`{"error":"Pod is restarting, please retry"}`)
	badGatewayBody = []byte(`{"error":"Project upstream is unavailable"}`)
	notFoundBody   = []byte(`{"error":"Project not found"}`)
	disabledBody   = []byte(`{"error":"Project is disabled"}`)
)

const (
	logModeOff      = "off"
	logModeMetadata = "metadata"
	logModeFull     = "full"
)

// logConfig is the effective request-logging policy for a single app request,
// resolved from the control-plane response with proxy-level fallbacks.
type logConfig struct {
	mode      string
	bodyLimit int
}

// captureBody reports whether request/response bodies should be captured for
// this request. Bodies are only captured in "full" mode and only when a
// positive byte budget is configured; in every other case the proxy streams
// without buffering for logging.
func (c logConfig) captureBody() bool {
	return c.mode == logModeFull && c.bodyLimit > 0
}

// logSettings resolves the per-project logging policy delivered by the control
// plane. A nil policy (older backend, or a non-logging surface) falls back to
// full logging with the proxy's default body limit, so behaviour is unchanged
// until a project explicitly opts into something lighter.
func (s *Server) logSettings(cfg *backend.LoggingConfig) logConfig {
	resolved := logConfig{mode: logModeFull, bodyLimit: s.cfg.RequestLogBodyLimit}

	if cfg != nil {
		if cfg.Mode != "" {
			resolved.mode = cfg.Mode
		}
		resolved.bodyLimit = cfg.BodyLimit
	}

	if resolved.bodyLimit < 0 {
		resolved.bodyLimit = 0
	}

	return resolved
}

// capturingReader tees up to limit bytes of a streamed response into an
// in-memory buffer while passing every byte through to the client untouched.
// This lets the proxy log a bounded prefix of a response without ever
// buffering the whole body — preserving streaming (SSE, chunked) and capping
// per-request memory at limit bytes.
type capturingReader struct {
	src     io.Reader
	capture []byte
	limit   int
}

func newCapturingReader(src io.Reader, limit int) *capturingReader {
	return &capturingReader{src: src, limit: limit}
}

func (c *capturingReader) Read(p []byte) (int, error) {
	n, err := c.src.Read(p)
	if n > 0 && len(c.capture) < c.limit {
		remaining := c.limit - len(c.capture)
		if remaining > n {
			remaining = n
		}
		c.capture = append(c.capture, p[:remaining]...)
	}
	return n, err
}

func (c *capturingReader) captured() string {
	return string(c.capture)
}

type Server struct {
	cfg         config.Config
	backend     *backend.Client
	transport   *http.Transport
	bufferPool  *bufferpool.Pool
	cache       *proxycache.Cache
	logger      *requestlog.Logger
	wsKeepAlive *upgradeKeepAlive
}

func New(
	cfg config.Config,
	backendClient *backend.Client,
	requestLogger *requestlog.Logger,
) *Server {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 200
	transport.MaxIdleConnsPerHost = 64
	transport.IdleConnTimeout = 90 * time.Second
	transport.TLSHandshakeTimeout = 10 * time.Second
	transport.ExpectContinueTimeout = time.Second

	return &Server{
		cfg:        cfg,
		backend:    backendClient,
		transport:  transport,
		bufferPool: bufferpool.New(32 * 1024),
		cache:      proxycache.New(),
		logger:     requestLogger,
		wsKeepAlive: newUpgradeKeepAlive(
			backendClient.TouchActivity,
			cfg.WebsocketKeepAliveInterval,
			cfg.ControlPlaneTimeout,
		),
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		writeJSONStatus(w, http.StatusOK, []byte(`{"status":"ok"}`))
		return
	}

	switch s.cfg.Mode {
	case config.ModeAgent:
		s.handleAgent(w, r)
	case config.ModeApp:
		s.handleApp(w, r)
	case config.ModeVSCode:
		s.handleSubdomain(w, r, backend.SurfaceVSCode)
	case config.ModeDB:
		s.handleSubdomain(w, r, backend.SurfaceDB)
	default:
		writeJSONStatus(w, http.StatusNotFound, notFoundBody)
	}
}

func (s *Server) Close(ctx context.Context) error {
	s.transport.CloseIdleConnections()

	var errs []error

	if s.logger != nil {
		if err := s.logger.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}

	return errors.Join(errs...)
}

func (s *Server) handleAgent(w http.ResponseWriter, r *http.Request) {
	projectID, upstreamPath, ok := extractAgentProject(r.URL.Path)
	if !ok {
		writeJSONStatus(w, http.StatusNotFound, notFoundBody)
		return
	}

	ensured, err := s.resolve(r.Context(), projectID, backend.SurfaceAgent, r.Header, authSignature(r.Header))
	if err != nil {
		s.writeEnsureError(w, err)
		return
	}

	if ensured.State != "ready" {
		writeStateResponse(w, ensured.State)
		return
	}

	targetURL, err := buildTargetURL(ensured.Upstream, upstreamPath, r.URL.RawQuery)
	if err != nil {
		s.sendFailureResponse(w, r.Context(), projectID)
		return
	}

	if isPromptSend(r.Method, upstreamPath) {
		s.stampPrompt(projectID)
	}

	if isUpgradeRequest(r) {
		release := s.wsKeepAlive.acquire(projectID, backend.SurfaceAgent)
		defer release()
	}

	s.serveReverseProxy(w, r, projectID, targetURL, reverseProxyOptions{stripUserIdentity: true})
}

// isPromptSend reports whether a proxied agent request is a user Prompt send.
// Only a POST to opencode's /session/{id}/prompt(_async) qualifies; event-stream
// connects, message fetches, session creation, aborts, pings, uploads, and every
// other surface are excluded.
func isPromptSend(method string, upstreamPath string) bool {
	return method == http.MethodPost && promptSendPattern.MatchString(upstreamPath)
}

// stampPrompt records a user Prompt against the environment on the control plane
// as a best-effort, fire-and-forget signal. It runs on a detached context so it
// never blocks, delays, or fails the proxied chat request; a failure is logged.
func (s *Server) stampPrompt(environmentID string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), s.cfg.ControlPlaneTimeout)
		defer cancel()

		if err := s.backend.StampPrompt(ctx, environmentID); err != nil {
			slog.Warn("failed to stamp last prompt", "environmentId", environmentID, "error", err.Error())
		}
	}()
}

func (s *Server) handleApp(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	projectID, hostLabel := extractAppHostLabel(r.Host)
	if projectID == "" {
		writeJSONStatus(w, http.StatusBadRequest, []byte(`{"error":"Invalid subdomain"}`))
		return
	}

	ensured, err := s.resolveLabeled(r.Context(), projectID, hostLabel, backend.SurfaceApp, r.Header, "")
	if err != nil {
		s.writeEnsureError(w, err)
		return
	}

	if redirected := redirectToCanonicalHost(w, r, projectID, ensured); redirected {
		return
	}

	if ensured.State != "ready" {
		writeStateResponse(w, ensured.State)
		return
	}

	targetURL, err := buildTargetURL(ensured.Upstream, pathOrSlash(r.URL.Path), r.URL.RawQuery)
	if err != nil {
		s.sendFailureResponse(w, r.Context(), projectID)
		return
	}

	if isUpgradeRequest(r) {
		release := s.wsKeepAlive.acquire(projectID, backend.SurfaceApp)
		defer release()
		s.serveReverseProxy(w, r, projectID, targetURL, reverseProxyOptions{})
		return
	}

	logCfg := s.logSettings(ensured.Logging)
	captureBody := logCfg.captureBody()

	startedAt := time.Now()
	requestBody, requestBodyText, err := s.readRequestBody(r, captureBody, logCfg.bodyLimit)
	if err != nil {
		writeJSONStatus(w, http.StatusBadRequest, badGatewayBody)
		return
	}

	responseResult, err := s.roundTripAppRequest(r, targetURL, requestBody, captureBody, logCfg.bodyLimit)
	if err != nil {
		s.sendFailureResponse(w, r.Context(), projectID)
		return
	}

	if responseResult.restart {
		s.sendFailureResponse(w, r.Context(), projectID)
		return
	}

	writeHeaderMap(w.Header(), responseResult.headers)
	w.WriteHeader(responseResult.statusCode)

	responseBodyText := responseResult.responseBody
	if len(responseResult.body) > 0 {
		_, _ = w.Write(responseResult.body)
	} else if responseResult.stream != nil {
		defer responseResult.stream.Close()
		// In full mode capture the body for any response that is text or carries no
		// Content-Type (most untyped app responses are JSON/text); explicitly binary
		// content types are streamed without capture to keep the log text-only.
		if captureBody && (responseResult.contentType == "" || isTextContent(responseResult.contentType)) {
			capturer := newCapturingReader(responseResult.stream, logCfg.bodyLimit)
			size, copyErr := copyBuffer(w, capturer, s.bufferPool)
			responseResult.responseSize = size
			responseBodyText = capturer.captured()
			if copyErr != nil {
				slog.Debug("app response stream interrupted", "projectId", projectID, "error", copyErr.Error())
			}
		} else {
			size, copyErr := copyBuffer(w, responseResult.stream, s.bufferPool)
			responseResult.responseSize = size
			if copyErr != nil {
				slog.Debug("app response stream interrupted", "projectId", projectID, "error", copyErr.Error())
			}
		}
	}

	if logCfg.mode != logModeOff && s.logger != nil {
		s.logger.Log(ensured.Directory, requestlog.Entry{
			Method:          r.Method,
			URL:             r.URL.RequestURI(),
			Domain:          r.Host,
			SourceIP:        sourceIP(r),
			Status:          responseResult.statusCode,
			Size:            responseResult.responseSize,
			DurationMillis:  time.Since(startedAt).Milliseconds(),
			RequestHeaders:  jsonHeader(r.Header),
			ResponseHeaders: jsonHeader(responseResult.headers),
			RequestBody:     requestBodyText,
			ResponseBody:    responseBodyText,
		})
	}
}

func (s *Server) handleSubdomain(w http.ResponseWriter, r *http.Request, surface backend.Surface) {
	setCORSHeaders(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	projectID := extractProjectIDFromHost(r.Host)
	if projectID == "" {
		writeJSONStatus(w, http.StatusBadRequest, []byte(`{"error":"Invalid subdomain"}`))
		return
	}

	ensured, err := s.resolve(r.Context(), projectID, surface, r.Header, "")
	if err != nil {
		s.writeEnsureError(w, err)
		return
	}

	if ensured.State != "ready" {
		writeStateResponse(w, ensured.State)
		return
	}

	targetBase := ensured.Upstream

	targetURL, err := buildTargetURL(targetBase, pathOrSlash(r.URL.Path), r.URL.RawQuery)
	if err != nil {
		s.sendFailureResponse(w, r.Context(), projectID)
		return
	}

	if isUpgradeRequest(r) {
		release := s.wsKeepAlive.acquire(projectID, surface)
		defer release()
	}

	s.serveReverseProxy(w, r, projectID, targetURL, reverseProxyOptions{
		dropAcceptEncoding: true,
		stripFrameHeaders:  true,
		stripOriginUpgrade: true,
		stripUserIdentity:  true,
	})
}

func (s *Server) resolve(
	ctx context.Context,
	projectID string,
	surface backend.Surface,
	headers http.Header,
	authKey string,
) (backend.EnsureResponse, error) {
	return s.resolveLabeled(ctx, projectID, projectID, surface, headers, authKey)
}

func (s *Server) resolveLabeled(
	ctx context.Context,
	projectID string,
	hostLabel string,
	surface backend.Surface,
	headers http.Header,
	authKey string,
) (backend.EnsureResponse, error) {
	cacheKey := fmt.Sprintf("%s|%s|%s", hostLabel, surface, authKey)

	return s.cache.GetOrLoad(ctx, cacheKey, projectID, s.cacheTTL, func(ctx context.Context) (backend.EnsureResponse, error) {
		return s.backend.Ensure(ctx, projectID, surface, headers)
	})
}

func (s *Server) cacheTTL(ensured backend.EnsureResponse) time.Duration {
	if ensured.State == "ready" {
		return s.cfg.ReadyCacheTTL
	}

	return s.cfg.NonReadyCacheTTL
}

func (s *Server) writeEnsureError(w http.ResponseWriter, err error) {
	var statusErr *backend.StatusError
	if errors.As(err, &statusErr) {
		writeStatusError(w, statusErr)
		return
	}

	writeJSONStatus(w, http.StatusBadGateway, badGatewayBody)
}

func (s *Server) sendFailureResponse(w http.ResponseWriter, ctx context.Context, projectID string) {
	restart, err := s.reportFailure(ctx, projectID)
	if err != nil {
		var statusErr *backend.StatusError
		if errors.As(err, &statusErr) && statusErr.StatusCode == http.StatusNotFound {
			writeJSONStatus(w, http.StatusNotFound, notFoundBody)
			return
		}

		slog.Error("proxy failure reporting failed", "projectId", projectID, "error", err.Error())
		writeJSONStatus(w, http.StatusBadGateway, badGatewayBody)
		return
	}

	if restart {
		writeRestarting(w)
		return
	}

	writeJSONStatus(w, http.StatusBadGateway, badGatewayBody)
}

func (s *Server) reportFailure(ctx context.Context, projectID string) (bool, error) {
	s.cache.InvalidateProject(projectID)
	return s.backend.ReportFailure(ctx, projectID)
}

type appProxyResult struct {
	restart      bool
	statusCode   int
	headers      http.Header
	body         []byte
	stream       io.ReadCloser
	contentType  string
	responseSize int64
	responseBody string
}

func (s *Server) roundTripAppRequest(
	r *http.Request,
	targetURL *url.URL,
	requestBody []byte,
	captureBody bool,
	bodyLimit int,
) (appProxyResult, error) {
	outgoing := r.Clone(r.Context())
	outgoing.URL = targetURL
	outgoing.Host = targetURL.Host
	outgoing.RequestURI = ""
	outgoing.Header = copyRequestHeaders(r.Header, true)
	stripAuthProxyHeaders(outgoing.Header)

	if len(requestBody) > 0 {
		outgoing.Body = io.NopCloser(bytes.NewReader(requestBody))
		outgoing.ContentLength = int64(len(requestBody))
	} else if hasRequestBody(r.Method) {
		outgoing.Body = r.Body
	}

	resp, err := s.transport.RoundTrip(outgoing)
	if err != nil {
		return appProxyResult{}, err
	}

	headers := filterResponseHeaders(resp.Header, false)

	if resp.StatusCode >= http.StatusBadRequest {
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return appProxyResult{}, err
		}

		if isK8sPodError(body) {
			return appProxyResult{restart: true}, nil
		}

		result := appProxyResult{
			statusCode:   resp.StatusCode,
			headers:      headers,
			body:         body,
			responseSize: int64(len(body)),
		}
		if captureBody {
			result.responseBody = truncate(string(body), bodyLimit)
		}
		return result, nil
	}

	contentType := resp.Header.Get("Content-Type")
	upstreamPath := targetURL.Path

	if upstreamPath != "/" && strings.Contains(contentType, "text/html") {
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return appProxyResult{}, err
		}

		rewritten := bytes.ReplaceAll(body, []byte(upstreamPath), nil)
		result := appProxyResult{
			statusCode:   resp.StatusCode,
			headers:      headers,
			body:         rewritten,
			responseSize: int64(len(rewritten)),
		}
		if captureBody {
			result.responseBody = truncate(string(body), bodyLimit)
		}
		return result, nil
	}

	return appProxyResult{
		statusCode:  resp.StatusCode,
		headers:     headers,
		stream:      resp.Body,
		contentType: contentType,
	}, nil
}

type reverseProxyOptions struct {
	dropAcceptEncoding bool
	stripFrameHeaders  bool
	stripOriginUpgrade bool
	stripUserIdentity  bool
}

func (s *Server) serveReverseProxy(
	w http.ResponseWriter,
	r *http.Request,
	projectID string,
	targetURL *url.URL,
	options reverseProxyOptions,
) {
	proxy := &httputil.ReverseProxy{
		Transport:     s.transport,
		FlushInterval: -1,
		BufferPool:    s.bufferPool,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.Out.URL.Scheme = targetURL.Scheme
			proxyRequest.Out.URL.Host = targetURL.Host
			proxyRequest.Out.URL.Path = targetURL.Path
			proxyRequest.Out.URL.RawPath = targetURL.RawPath
			proxyRequest.Out.URL.RawQuery = targetURL.RawQuery
			proxyRequest.Out.Host = targetURL.Host
			passThroughForwardedHeaders(proxyRequest.Out.Header, proxyRequest.In.Header)
			stripAuthProxyHeaders(proxyRequest.Out.Header)
			if options.stripUserIdentity {
				stripUserIdentityHeaders(proxyRequest.Out.Header)
			}
			if options.dropAcceptEncoding {
				proxyRequest.Out.Header.Del("Accept-Encoding")
			}
			if options.stripOriginUpgrade && isUpgradeRequest(proxyRequest.In) {
				proxyRequest.Out.Header.Del("Origin")
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			sanitizeReverseProxyHeaders(resp.Header, options.stripFrameHeaders)
			if resp.StatusCode < http.StatusBadRequest {
				return nil
			}

			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}

			_ = resp.Body.Close()

			if isK8sPodError(body) {
				restart, reportErr := s.reportFailure(resp.Request.Context(), projectID)
				if reportErr != nil {
					slog.Error("proxy failure reporting failed", "projectId", projectID, "error", reportErr.Error())
					restart = false
				}

				if restart {
					mutateResponse(resp, http.StatusServiceUnavailable, restartingBody)
					resp.Header.Set(retryAfterHeader, restartRetryAfterSeconds)
				} else {
					mutateResponse(resp, http.StatusBadGateway, badGatewayBody)
				}
				return nil
			}

			resp.Body = io.NopCloser(bytes.NewReader(body))
			resp.ContentLength = int64(len(body))
			resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, req *http.Request, err error) {
			if req.Context().Err() != nil {
				return
			}

			slog.Error("reverse proxy error", "projectId", projectID, "error", err.Error())
			s.sendFailureResponse(rw, req.Context(), projectID)
		},
	}

	proxy.ServeHTTP(w, r)
}

func (s *Server) readRequestBody(r *http.Request, captureBody bool, bodyLimit int) ([]byte, string, error) {
	if !hasRequestBody(r.Method) {
		return nil, "", nil
	}

	// When body capture is disabled (logging off or metadata-only) there is no
	// reason to buffer the request: stream it straight through so large uploads
	// and long-lived requests never accumulate in proxy memory.
	if !captureBody {
		return nil, "", nil
	}

	if !shouldBufferRequest(r.Header, s.cfg.RequestBufferLimit) {
		return nil, "", nil
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, "", err
	}

	r.Body = io.NopCloser(bytes.NewReader(body))

	return body, truncate(string(body), bodyLimit), nil
}

func extractAgentProject(path string) (string, string, bool) {
	const prefix = "/api/proxy/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}

	trimmed := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(trimmed, "/", 2)
	if len(parts) == 0 || !projectIDPattern.MatchString(parts[0]) {
		return "", "", false
	}

	if len(parts) == 1 {
		return parts[0], "/", true
	}

	return parts[0], "/" + parts[1], true
}

func extractProjectIDFromHost(host string) string {
	subdomain := firstHostLabel(host)
	if !projectIDPattern.MatchString(subdomain) {
		return ""
	}

	return subdomain
}

// extractAppHostLabel parses the public app host label, which is either a bare
// 36-char environment uuid or "{envId}-{slug}". The uuid's fixed length is the
// parsing rule (ADR 0012); anything that doesn't fit it is treated as a whole
// label and fails resolution downstream.
func extractAppHostLabel(host string) (string, string) {
	label := firstHostLabel(host)
	if !projectIDPattern.MatchString(label) {
		return "", ""
	}

	if len(label) > environmentIDLength && label[environmentIDLength] == '-' {
		return label[:environmentIDLength], label
	}

	return label, label
}

func firstHostLabel(host string) string {
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}

	return strings.Split(host, ".")[0]
}

// redirectToCanonicalHost issues a permanent redirect when the request arrived
// on a host that may not serve this environment. The canonical slugged host
// and the legacy bare env-id host both serve — the per-environment auth
// IngressRoute matches both, so neither bypasses the auth gate. Anything else
// (a wrong slug) redirects to canonical.
func redirectToCanonicalHost(w http.ResponseWriter, r *http.Request, envID string, ensured backend.EnsureResponse) bool {
	if ensured.CanonicalHost == "" {
		return false
	}

	requestLabel := firstHostLabel(r.Host)
	canonicalLabel := strings.Split(ensured.CanonicalHost, ".")[0]

	if strings.EqualFold(requestLabel, canonicalLabel) || strings.EqualFold(requestLabel, envID) {
		return false
	}

	w.Header().Set("Location", "https://"+ensured.CanonicalHost+r.URL.RequestURI())
	w.WriteHeader(http.StatusPermanentRedirect)
	return true
}

func buildTargetURL(upstream string, requestPath string, rawQuery string) (*url.URL, error) {
	base, err := url.Parse(upstream)
	if err != nil {
		return nil, err
	}

	target := *base
	target.Path = joinURLPath(base.Path, requestPath)
	target.RawPath = target.Path
	target.RawQuery = rawQuery
	return &target, nil
}

func joinURLPath(basePath string, requestPath string) string {
	if requestPath == "" {
		requestPath = "/"
	}

	switch {
	case strings.HasSuffix(basePath, "/") && strings.HasPrefix(requestPath, "/"):
		return basePath + requestPath[1:]
	case !strings.HasSuffix(basePath, "/") && !strings.HasPrefix(requestPath, "/"):
		return basePath + "/" + requestPath
	default:
		return basePath + requestPath
	}
}

func pathOrSlash(path string) string {
	if path == "" {
		return "/"
	}

	return path
}

func hasRequestBody(method string) bool {
	return method != http.MethodGet && method != http.MethodHead
}

func shouldBufferRequest(headers http.Header, limit int64) bool {
	contentType := headers.Get("Content-Type")
	if strings.Contains(contentType, "multipart") {
		return false
	}

	contentLength, err := strconv.ParseInt(headers.Get("Content-Length"), 10, 64)
	if err != nil || contentLength <= 0 {
		return true
	}

	return contentLength <= limit
}

func copyRequestHeaders(source http.Header, dropAcceptEncoding bool) http.Header {
	target := make(http.Header, len(source))

	for key, values := range source {
		lower := strings.ToLower(key)
		if isHopByHopHeader(lower) {
			continue
		}
		if dropAcceptEncoding && lower == "accept-encoding" {
			continue
		}

		for _, value := range values {
			target.Add(key, value)
		}
	}

	return target
}

func passThroughForwardedHeaders(out http.Header, in http.Header) {
	for _, name := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "X-Forwarded"} {
		if vals := in.Values(name); len(vals) > 0 {
			out[name] = append([]string(nil), vals...)
		}
	}
}

func isHopByHopHeader(name string) bool {
	switch name {
	case "connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host":
		return true
	default:
		return false
	}
}

var authProxyHeaders = []string{
	"X-Forwarded-Access-Token",
	"X-Forwarded-Id-Token",
	"X-Forwarded-Refresh-Token",
	"X-Forwarded-User",
	"X-Forwarded-Email",
	"X-Forwarded-Preferred-Username",
	"X-Forwarded-Groups",
	"X-Auth-Request-Access-Token",
	"X-Auth-Request-User",
	"X-Auth-Request-Email",
	"X-Auth-Request-Preferred-Username",
	"X-Auth-Request-Groups",
	"X-Auth-Request-Redirect",
}

func stripAuthProxyHeaders(headers http.Header) {
	for _, name := range authProxyHeaders {
		headers.Del(name)
	}
}

func stripUserIdentityHeaders(headers http.Header) {
	headers.Del("Cookie")
	headers.Del("Authorization")
}

func sanitizeReverseProxyHeaders(headers http.Header, stripFrameHeaders bool) {
	headers.Del("Transfer-Encoding")
	if stripFrameHeaders {
		headers.Del("Content-Length")
		headers.Del("Content-Encoding")
		headers.Del("X-Frame-Options")
		headers.Del("Content-Security-Policy")
	}
}

func filterResponseHeaders(source http.Header, stripFrameHeaders bool) http.Header {
	target := make(http.Header, len(source))

	for key, values := range source {
		lower := strings.ToLower(key)
		if lower == "transfer-encoding" || lower == "content-length" {
			continue
		}
		if stripFrameHeaders && (lower == "content-encoding" || lower == "x-frame-options" || lower == "content-security-policy") {
			continue
		}

		for _, value := range values {
			target.Add(key, value)
		}
	}

	return target
}

func mutateResponse(resp *http.Response, statusCode int, body []byte) {
	resp.StatusCode = statusCode
	resp.Status = fmt.Sprintf("%d %s", statusCode, http.StatusText(statusCode))
	resp.Header = make(http.Header)
	resp.Header.Set("Content-Type", "application/json")
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.ContentLength = int64(len(body))
	resp.Body = io.NopCloser(bytes.NewReader(body))
}

func writeStateResponse(w http.ResponseWriter, state string) {
	switch state {
	case "starting":
		writeRestarting(w)
	case "disabled":
		writeJSONStatus(w, http.StatusLocked, disabledBody)
	default:
		writeJSONStatus(w, http.StatusBadGateway, badGatewayBody)
	}
}

func writeStatusError(w http.ResponseWriter, statusErr *backend.StatusError) {
	if statusErr.StatusCode == http.StatusNotFound {
		writeJSONStatus(w, http.StatusNotFound, notFoundBody)
		return
	}

	contentType := "application/json"
	if !json.Valid(statusErr.Body) {
		contentType = "text/plain; charset=utf-8"
	}

	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(statusErr.StatusCode)
	if len(statusErr.Body) > 0 {
		_, _ = w.Write(statusErr.Body)
	}
}

func writeJSONStatus(w http.ResponseWriter, statusCode int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write(body)
}

func writeRestarting(w http.ResponseWriter) {
	w.Header().Set(retryAfterHeader, restartRetryAfterSeconds)
	writeJSONStatus(w, http.StatusServiceUnavailable, restartingBody)
}

func writeHeaderMap(target http.Header, source http.Header) {
	for key, values := range source {
		for _, value := range values {
			target.Add(key, value)
		}
	}
}

func setCORSHeaders(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}

	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type, authorization")
	w.Header().Set("Access-Control-Allow-Credentials", "true")
}

func copyBuffer(dst io.Writer, src io.Reader, pool *bufferpool.Pool) (int64, error) {
	buf := pool.Get()
	defer pool.Put(buf)
	return io.CopyBuffer(dst, src, buf)
}

func isTextContent(contentType string) bool {
	return strings.Contains(contentType, "application/json") ||
		strings.Contains(contentType, "text/") ||
		strings.Contains(contentType, "application/xml") ||
		strings.Contains(contentType, "application/javascript")
}

func isK8sPodError(body []byte) bool {
	var payload struct {
		Kind   string `json:"kind"`
		Status string `json:"status"`
	}

	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}

	return payload.Kind == "Status" && payload.Status == "Failure"
}

func isUpgradeRequest(r *http.Request) bool {
	return headerContainsToken(r.Header, "Connection", "upgrade") && r.Header.Get("Upgrade") != ""
}

func headerContainsToken(headers http.Header, key string, token string) bool {
	for _, value := range headers.Values(key) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}

	return false
}

func sourceIP(r *http.Request) string {
	if realIP := r.Header.Get("X-Real-Ip"); realIP != "" {
		return realIP
	}

	if forwardedFor := r.Header.Get("X-Forwarded-For"); forwardedFor != "" {
		first := strings.Split(forwardedFor, ",")[0]
		return strings.TrimSpace(first)
	}

	remoteIP, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return remoteIP
	}

	return r.RemoteAddr
}

func truncate(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}

	return value[:limit]
}

// sensitiveLogHeaders are never written to the request log in clear text. They
// carry credentials or session material that must not be persisted to the
// per-project SQLite log.
var sensitiveLogHeaders = map[string]struct{}{
	"authorization":               {},
	"proxy-authorization":         {},
	"cookie":                      {},
	"set-cookie":                  {},
	"x-api-key":                   {},
	"x-forwarded-access-token":    {},
	"x-forwarded-id-token":        {},
	"x-forwarded-refresh-token":   {},
	"x-auth-request-access-token": {},
	"x-proxy-control-token":       {},
}

func jsonHeader(headers http.Header) string {
	if len(headers) == 0 {
		return ""
	}

	payload := make(map[string]string, len(headers))
	for key := range headers {
		if _, redacted := sensitiveLogHeaders[strings.ToLower(key)]; redacted {
			payload[key] = "[redacted]"
			continue
		}
		payload[key] = headers.Get(key)
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return ""
	}

	return string(encoded)
}

func authSignature(headers http.Header) string {
	hash := sha1.New()
	for _, name := range backend.ForwardedIdentityCacheHeaders {
		value := headers.Get(name)
		_, _ = fmt.Fprintf(hash, "%d:%s", len(value), value)
	}
	gateway := backend.GatewayBearer(headers)
	_, _ = fmt.Fprintf(hash, "%d:%s", len(gateway), gateway)
	return hex.EncodeToString(hash.Sum(nil))
}
