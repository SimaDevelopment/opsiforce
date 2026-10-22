package gate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/config"
)

const (
	idleConnectionTimeout = 60 * time.Second
	callerIdentityHeader  = "X-Opsiforce-Caller"
	reservedHeaderPrefix  = "x-opsiforce-"
	basicChallenge        = `Basic realm="Opsiforce"`
)

var slugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

type Gate struct {
	callers      *callerCache
	webhooks     *callerCache
	transport    *http.Transport
	proxy        *httputil.ReverseProxy
	webhookProxy *httputil.ReverseProxy
	backendURL   *url.URL
	controlToken string
}

type forwardedCall struct {
	upstream  *url.URL
	identity  string
	presented presentedKey
	slug      string
}

type forwardedCallKey struct{}

func New(cfg config.Config, platform *backend.Client) *Gate {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	transport.ForceAttemptHTTP2 = false
	transport.MaxIdleConns = 200
	transport.MaxIdleConnsPerHost = 64
	transport.IdleConnTimeout = idleConnectionTimeout

	backendURL, err := url.Parse(cfg.BackendURL)
	if err != nil {
		backendURL = &url.URL{}
	}
	gate := &Gate{
		callers:      newCallerCache(cfg.CallerCacheTTL, cfg.ServiceStartHold, platform.ResolveCaller),
		webhooks:     newCallerCache(cfg.CallerCacheTTL, cfg.ServiceStartHold, resolveWebhookTarget(platform)),
		transport:    transport,
		backendURL:   backendURL,
		controlToken: cfg.ProxyControlToken,
	}
	gate.proxy = &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Rewrite:       gate.rewrite,
		ErrorHandler:  gate.unreachable,
	}
	gate.webhookProxy = &httputil.ReverseProxy{
		Transport:      transport,
		FlushInterval:  -1,
		Rewrite:        gate.rewriteWebhook,
		ModifyResponse: sandboxAnswer,
		ErrorHandler:   gate.unreachableWebhook,
	}
	return gate
}

func (d *Gate) Close() {
	d.transport.CloseIdleConnections()
}

func (d *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	slug := slugOf(r.Host)
	if slug == "" {
		writeMessage(w, http.StatusNotFound, "There is no External Service at this address.")
		return
	}

	presented, ok := findGatewayKey(r.Header)
	if !ok {
		writeUnauthorized(w, "Send your Gateway Key (gw-…) in a request header.")
		return
	}

	resolution, err := d.callers.caller(r.Context(), presented, slug)
	if err != nil {
		d.refuse(w, r, slug, err)
		return
	}

	upstream, err := d.upstreamOf(resolution)
	if err != nil {
		slog.Error("external service resolved to an unusable upstream", "slug", slug, "upstream", resolution.Upstream)
		writeMessage(w, http.StatusBadGateway, fmt.Sprintf("%s could not be reached.", slug))
		return
	}

	call := forwardedCall{upstream: upstream, identity: resolution.CallerIdentity, presented: presented, slug: slug}
	d.proxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), forwardedCallKey{}, call)))
}

func (d *Gate) refuse(w http.ResponseWriter, r *http.Request, slug string, err error) {
	if r.Context().Err() != nil {
		return
	}

	var refused *backend.StatusError
	if errors.As(err, &refused) {
		message := messageIn(refused.Body)
		switch refused.StatusCode {
		case http.StatusUnauthorized:
			writeUnauthorized(w, firstNonEmpty(message, "This Gateway Key is unknown or revoked."))
			return
		case http.StatusNotFound, http.StatusBadGateway, http.StatusGatewayTimeout:
			writeMessage(w, refused.StatusCode, firstNonEmpty(message, http.StatusText(refused.StatusCode)))
			return
		}
		slog.Error("external service resolve refused unexpectedly", "slug", slug, "status", refused.StatusCode)
		writeMessage(w, http.StatusBadGateway, "The platform could not resolve this call; retry shortly.")
		return
	}

	if errors.Is(err, context.DeadlineExceeded) {
		writeMessage(w, http.StatusGatewayTimeout, fmt.Sprintf("%s did not start in time; retry shortly.", slug))
		return
	}

	slog.Error("external service resolve failed", "slug", slug, "error", err.Error())
	writeMessage(w, http.StatusBadGateway, "The platform could not resolve this call; retry shortly.")
}

func (d *Gate) rewrite(pr *httputil.ProxyRequest) {
	call := pr.In.Context().Value(forwardedCallKey{}).(forwardedCall)

	pr.Out.URL.Scheme = call.upstream.Scheme
	pr.Out.URL.Host = call.upstream.Host
	pr.Out.URL.Path, pr.Out.URL.RawPath = belowUpstream(call.upstream, pr.In.URL.EscapedPath())
	pr.Out.Host = pr.In.Host
	forwardOriginalAddress(pr.Out.Header, pr.In)

	for _, name := range call.presented.headers {
		pr.Out.Header.Del(name)
	}
	for name := range pr.Out.Header {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
			delete(pr.Out.Header, name)
		}
	}
	pr.Out.Header.Set(callerIdentityHeader, call.identity)
}

func (d *Gate) unreachable(w http.ResponseWriter, r *http.Request, err error) {
	if r.Context().Err() != nil {
		return
	}
	call := r.Context().Value(forwardedCallKey{}).(forwardedCall)
	d.callers.forget(callerAddress{key: call.presented.key, slug: call.slug})
	slog.Warn("external service unreachable", "slug", call.slug, "error", err.Error())
	writeMessage(w, http.StatusBadGateway, fmt.Sprintf("%s could not be reached.", call.slug))
}

var errUnusableUpstream = errors.New("unusable upstream")

func (d *Gate) upstreamOf(resolution backend.CallerResolution) (*url.URL, error) {
	if resolution.ServedBy == backend.ServedByBuiltIn {
		if !strings.HasPrefix(resolution.Upstream, "/") || d.backendURL.Host == "" {
			return nil, errUnusableUpstream
		}
		return d.backendURL.ResolveReference(&url.URL{Path: resolution.Upstream}), nil
	}
	upstream, err := url.Parse(resolution.Upstream)
	if err != nil || upstream.Host == "" {
		return nil, errUnusableUpstream
	}
	return upstream, nil
}

func belowUpstream(upstream *url.URL, escapedPath string) (string, string) {
	rawPath := strings.TrimSuffix(upstream.EscapedPath(), "/") + escapedPath
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return rawPath, rawPath
	}
	return path, rawPath
}

func forwardOriginalAddress(out http.Header, in *http.Request) {
	for _, name := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
		if values := in.Header.Values(name); len(values) > 0 {
			out[name] = append([]string(nil), values...)
		}
	}
	if out.Get("X-Forwarded-Host") == "" {
		out.Set("X-Forwarded-Host", in.Host)
	}
	if out.Get("X-Forwarded-Proto") == "" {
		out.Set("X-Forwarded-Proto", schemeOf(in))
	}
	if out.Get("X-Forwarded-For") == "" {
		if clientIP, _, err := net.SplitHostPort(in.RemoteAddr); err == nil {
			out.Set("X-Forwarded-For", clientIP)
		}
	}
}

func schemeOf(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func slugOf(host string) string {
	if withoutPort, _, err := net.SplitHostPort(host); err == nil {
		host = withoutPort
	}
	label, _, found := strings.Cut(strings.ToLower(host), ".")
	if !found || !slugPattern.MatchString(label) {
		return ""
	}
	return label
}

func messageIn(body []byte) string {
	var answer struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &answer) != nil {
		return ""
	}
	return answer.Message
}

func writeUnauthorized(w http.ResponseWriter, message string) {
	w.Header().Set("WWW-Authenticate", basicChallenge)
	writeMessage(w, http.StatusUnauthorized, message)
}

func writeMessage(w http.ResponseWriter, status int, message string) {
	body, _ := json.Marshal(map[string]string{"message": message})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
