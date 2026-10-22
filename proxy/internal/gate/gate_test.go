package gate

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/config"
)

const (
	testKey          = "gw-AbC_123-xyz"
	testSlug         = "github"
	testTenant       = "tenant-1"
	testIdentity     = "header.claims.signature"
	testControlToken = "control-token"
)

type resolveCall struct {
	Credential string
	Slug       string
	Token      string
}

type fakePlatform struct {
	mu       sync.Mutex
	calls    []resolveCall
	upstream string
	servedBy string
	status   int
	message  string
	delay    time.Duration
}

func (p *fakePlatform) handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/internal/proxy/external-services/resolve" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		Credential string `json:"credential"`
		Slug       string `json:"slug"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	p.mu.Lock()
	p.calls = append(p.calls, resolveCall{Credential: body.Credential, Slug: body.Slug, Token: r.Header.Get("x-proxy-control-token")})
	status, message, upstream, servedBy, delay := p.status, p.message, p.upstream, p.servedBy, p.delay
	p.mu.Unlock()
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
	}
	w.Header().Set("content-type", "application/json")
	if status != 0 && status != http.StatusOK {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{
		"servedBy":       firstNonEmpty(servedBy, "pod"),
		"upstream":       upstream,
		"callerIdentity": testIdentity,
		"tenantId":       testTenant,
		"serviceId":      "service-1",
	})
}

func (p *fakePlatform) serveBuiltIn(path string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.servedBy = "built-in"
	p.upstream = path
}

func (p *fakePlatform) resolveCalls() []resolveCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]resolveCall(nil), p.calls...)
}

func (p *fakePlatform) slowDown(delay time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.delay = delay
}

func (p *fakePlatform) answer(status int, message string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.status = status
	p.message = message
}

type receivedRequest struct {
	Method     string
	RequestURI string
	Host       string
	Header     http.Header
	Body       []byte
	Chunked    bool
}

type fakeService struct {
	mu       sync.Mutex
	received []receivedRequest
	answer   http.HandlerFunc
}

func (s *fakeService) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.received = append(s.received, receivedRequest{
		Method:     r.Method,
		RequestURI: r.RequestURI,
		Host:       r.Host,
		Header:     r.Header.Clone(),
		Body:       body,
		Chunked:    len(r.TransferEncoding) > 0 && r.TransferEncoding[0] == "chunked",
	})
	answer := s.answer
	s.mu.Unlock()
	if answer != nil {
		answer(w, r)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("from the service"))
}

func (s *fakeService) requests() []receivedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]receivedRequest(nil), s.received...)
}

type stack struct {
	platform  *fakePlatform
	service   *fakeService
	serviceAt *httptest.Server
	gate      *Gate
	url       string
	control   string
}

func newStack(t *testing.T, tune ...func(*config.Config)) *stack {
	t.Helper()
	service := &fakeService{}
	serviceAt := httptest.NewServer(http.HandlerFunc(service.handler))
	t.Cleanup(serviceAt.Close)

	platform := &fakePlatform{upstream: serviceAt.URL}
	platformAt := httptest.NewServer(http.HandlerFunc(platform.handler))
	t.Cleanup(platformAt.Close)

	cfg := config.Config{
		Mode:              config.ModeExternalService,
		BackendURL:        serviceAt.URL,
		ProxyControlToken: testControlToken,
		ServiceStartHold:  5 * time.Second,
		CallerCacheTTL:    5 * time.Second,
	}
	for _, change := range tune {
		change(&cfg)
	}
	gate := New(cfg, backend.New(platformAt.URL, testControlToken, time.Second))
	doorAt := httptest.NewServer(gate)
	t.Cleanup(doorAt.Close)
	controlAt := httptest.NewServer(gate.ControlHandler())
	t.Cleanup(controlAt.Close)
	t.Cleanup(func() { gate.Close() })

	return &stack{platform: platform, service: service, serviceAt: serviceAt, gate: gate, url: doorAt.URL, control: controlAt.URL}
}

var rawClient = &http.Client{
	Transport: &http.Transport{DisableCompression: true, Proxy: nil},
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

func (s *stack) request(t *testing.T, method string, path string, body io.Reader, header http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, s.url+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = testSlug + ".external-services.opsiforce.test"
	for name, values := range header {
		req.Header[name] = values
	}
	resp, err := rawClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func keyHeader(name string, value string) http.Header {
	return http.Header{name: {value}}
}

func basic(user string, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func messageOf(t *testing.T, resp *http.Response) string {
	t.Helper()
	var answer map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		t.Fatalf("own answer is not {\"message\"}: %v", err)
	}
	if len(answer) != 1 || answer["message"] == "" {
		t.Fatalf("own answer = %v, want exactly a message", answer)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("own answer content type = %q", got)
	}
	return answer["message"]
}

func TestFindsTheGatewayKeyInAnyHeaderAndRemovesThatHeader(t *testing.T) {
	shapes := map[string]http.Header{
		"bearer":           keyHeader("Authorization", "Bearer "+testKey),
		"gh token":         keyHeader("Authorization", "token "+testKey),
		"basic username":   keyHeader("Authorization", basic(testKey, "x-oauth-basic")),
		"basic password":   keyHeader("Authorization", basic("git", testKey)),
		"gitlab":           keyHeader("Private-Token", testKey),
		"api key":          keyHeader("X-Api-Key", testKey),
		"vendor header":    keyHeader("X-Trello-Token", "key="+testKey),
		"proxy authorizer": keyHeader("Proxy-Authorization", "Bearer "+testKey),
	}
	for name, header := range shapes {
		t.Run(name, func(t *testing.T) {
			s := newStack(t)
			var headerName, sent string
			for name, values := range header {
				headerName, sent = name, values[0]
			}
			header.Set("X-Kept", "kept")
			resp := s.request(t, http.MethodGet, "/repos/acme/web", nil, header)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status %d: %s", resp.StatusCode, readAll(t, resp))
			}
			got := s.service.requests()
			if len(got) != 1 {
				t.Fatalf("service received %d requests", len(got))
			}
			if values := got[0].Header.Values(headerName); len(values) != 0 {
				t.Fatalf("%s reached the service: %v", headerName, values)
			}
			if got[0].Header.Get("X-Opsiforce-Caller") != testIdentity {
				t.Fatalf("caller identity = %q", got[0].Header.Get("X-Opsiforce-Caller"))
			}
			if got[0].Header.Get("X-Kept") != "kept" {
				t.Fatal("an unrelated header was touched")
			}
			calls := s.platform.resolveCalls()
			if len(calls) != 1 || calls[0].Credential != sent || calls[0].Slug != testSlug || calls[0].Token != testControlToken {
				t.Fatalf("resolve calls = %+v, want the header value %q verbatim", calls, sent)
			}
		})
	}
}

func TestNeverReadsTheKeyFromTheURLOrTheBody(t *testing.T) {
	cases := map[string]func(s *stack) *http.Response{
		"query": func(s *stack) *http.Response {
			return s.request(t, http.MethodGet, "/repos?access_token="+testKey, nil, nil)
		},
		"path": func(s *stack) *http.Response {
			return s.request(t, http.MethodGet, "/"+testKey+"/repos", nil, nil)
		},
		"body": func(s *stack) *http.Response {
			return s.request(t, http.MethodPost, "/token", strings.NewReader(`{"token":"`+testKey+`"}`), keyHeader("Content-Type", "application/json"))
		},
		"form": func(s *stack) *http.Response {
			return s.request(t, http.MethodPost, "/token", strings.NewReader(url.Values{"key": {testKey}}.Encode()), keyHeader("Content-Type", "application/x-www-form-urlencoded"))
		},
	}
	for name, send := range cases {
		t.Run(name, func(t *testing.T) {
			s := newStack(t)
			resp := send(s)
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status %d, want 401", resp.StatusCode)
			}
			if resp.Header.Get("WWW-Authenticate") != `Basic realm="Opsiforce"` {
				t.Fatalf("challenge = %q", resp.Header.Get("WWW-Authenticate"))
			}
			messageOf(t, resp)
			if len(s.platform.resolveCalls()) != 0 || len(s.service.requests()) != 0 {
				t.Fatal("a request without a key in a header went past the front gate")
			}
		})
	}
}

func TestRemovesEveryIncomingOpsiforceHeaderAndTouchesNothingElse(t *testing.T) {
	s := newStack(t)
	header := http.Header{
		"X-Api-Key":            {testKey},
		"Authorization":        {"Bearer upstream-token-the-service-ignores"},
		"Cookie":               {"session=abc"},
		"X-Opsiforce-Caller":   {"forged"},
		"X-Opsiforce-Gate":     {"forged"},
		"X-Opsiforce-Anything": {"forged"},
		"User-Agent":           {"git/2.49.0"},
		"Git-Protocol":         {"version=2"},
		"X-Forwarded-Proto":    {"https"},
		"X-Forwarded-Host":     {"github.external-services.opsiforce.test"},
		"Content-Type":         {"application/x-git-upload-pack-request"},
		"X-Repeated":           {"one", "two"},
		"Opsiforce-Outcome":    {"caller-sent"},
	}
	resp := s.request(t, http.MethodPost, "/acme/web.git/git-upload-pack", strings.NewReader("0000"), header)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	got := s.service.requests()[0]
	if values := got.Header.Values("X-Opsiforce-Caller"); len(values) != 1 || values[0] != testIdentity {
		t.Fatalf("caller identity header = %v", values)
	}
	for name := range got.Header {
		if strings.HasPrefix(strings.ToLower(name), "x-opsiforce-") && name != "X-Opsiforce-Caller" {
			t.Fatalf("incoming %s reached the service", name)
		}
	}
	if got.Header.Get("X-Api-Key") != "" {
		t.Fatal("the key header reached the service")
	}
	for name, want := range map[string]string{
		"Authorization":     "Bearer upstream-token-the-service-ignores",
		"Cookie":            "session=abc",
		"User-Agent":        "git/2.49.0",
		"Git-Protocol":      "version=2",
		"Content-Type":      "application/x-git-upload-pack-request",
		"Opsiforce-Outcome": "caller-sent",
		"X-Forwarded-Proto": "https",
		"X-Forwarded-Host":  "github.external-services.opsiforce.test",
	} {
		if got.Header.Get(name) != want {
			t.Errorf("%s = %q, want %q", name, got.Header.Get(name), want)
		}
	}
	if values := got.Header.Values("X-Repeated"); len(values) != 2 {
		t.Errorf("repeated header = %v", values)
	}
	if got.Host != "github.external-services.opsiforce.test" {
		t.Errorf("Host = %q, want the original Service host", got.Host)
	}
	if got.Header.Get("Accept-Encoding") != "" {
		t.Errorf("the front gate added Accept-Encoding %q", got.Header.Get("Accept-Encoding"))
	}
}

func TestFillsForwardedHostAndProtoWhenTheEdgeDidNot(t *testing.T) {
	s := newStack(t)
	s.request(t, http.MethodGet, "/", nil, keyHeader("Authorization", "Bearer "+testKey))
	got := s.service.requests()[0]
	if got.Header.Get("X-Forwarded-Host") != "github.external-services.opsiforce.test" || got.Header.Get("X-Forwarded-Proto") != "http" {
		t.Fatalf("forwarded host %q proto %q", got.Header.Get("X-Forwarded-Host"), got.Header.Get("X-Forwarded-Proto"))
	}
}

func TestPassesTheRequestThroughByteForByte(t *testing.T) {
	s := newStack(t)
	paths := []string{
		"/repos/acme/web/contents/a%2Fb%20c.txt?ref=main&x=%2F&x=2",
		"/a/../b//c/./d;param?q",
		"/api/v1/namespaces/default/pods/web-0/log?follow=true&container=app",
		"/%5Cweird/%2e%2E/path",
	}
	for _, path := range paths {
		s.request(t, http.MethodGet, path, nil, keyHeader("Authorization", "Bearer "+testKey))
	}
	for i, got := range s.service.requests() {
		if got.RequestURI != paths[i] {
			t.Errorf("service saw %q, caller sent %q", got.RequestURI, paths[i])
		}
	}
}

func TestStreamsAChunkedGzipUploadUntouched(t *testing.T) {
	s := newStack(t)
	payload := strings.Repeat("\x1f\x8b binary pack data \x00\xff", 4096)
	reader, writer := io.Pipe()
	go func() {
		for i := 0; i < len(payload); i += 1000 {
			_, _ = writer.Write([]byte(payload[i:min(i+1000, len(payload))]))
		}
		_ = writer.Close()
	}()
	header := http.Header{"Authorization": {basic("git", testKey)}, "Content-Encoding": {"gzip"}}
	resp := s.request(t, http.MethodPost, "/acme/web.git/git-receive-pack", reader, header)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	got := s.service.requests()[0]
	if string(got.Body) != payload {
		t.Fatalf("body changed: %d bytes in, %d bytes out", len(payload), len(got.Body))
	}
	if !got.Chunked || got.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("chunked %v content encoding %q", got.Chunked, got.Header.Get("Content-Encoding"))
	}
}

func TestReturnsEveryAnswerUntouched(t *testing.T) {
	k8sStatus := `{"kind":"Status","apiVersion":"v1","status":"Failure","message":"pods \"web-0\" not found","reason":"NotFound","code":404}`
	gzipped := "\x1f\x8b\x08\x00compressed-bytes\x00\xff"
	answers := []struct {
		status int
		header http.Header
		body   string
	}{
		{http.StatusNotFound, http.Header{"Content-Type": {"application/json"}}, k8sStatus},
		{http.StatusInternalServerError, http.Header{"Content-Type": {"text/html"}}, "<html>/acme/web broke</html>"},
		{http.StatusForbidden, http.Header{"Content-Type": {"application/problem+json"}, "Opsiforce-Outcome": {"not allowed"}, "Opsiforce-Setting": {"merge"}}, `{"title":"not allowed"}`},
		{http.StatusOK, http.Header{"Content-Encoding": {"gzip"}, "Content-Type": {"application/octet-stream"}}, gzipped},
		{http.StatusTeapot, http.Header{"X-Opsiforce-From-Service": {"kept"}, "Set-Cookie": {"a=b"}, "Access-Control-Allow-Origin": {"https://x.test"}}, "short and stout"},
	}
	for _, want := range answers {
		s := newStack(t)
		s.service.answer = func(w http.ResponseWriter, _ *http.Request) {
			for name, values := range want.header {
				w.Header()[name] = values
			}
			w.WriteHeader(want.status)
			_, _ = w.Write([]byte(want.body))
		}
		resp := s.request(t, http.MethodGet, "/", nil, keyHeader("Authorization", "Bearer "+testKey))
		if resp.StatusCode != want.status {
			t.Errorf("status %d, want %d", resp.StatusCode, want.status)
		}
		if body := readAll(t, resp); body != want.body {
			t.Errorf("body %q, want %q", body, want.body)
		}
		for name, values := range want.header {
			if got := resp.Header.Values(name); strings.Join(got, ",") != strings.Join(values, ",") {
				t.Errorf("%s = %v, want %v", name, got, values)
			}
		}
	}
}

func TestFlushesAStreamedAnswerImmediately(t *testing.T) {
	s := newStack(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	s.service.answer = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: first line\n\n"))
		w.(http.Flusher).Flush()
		<-release
	}
	resp := s.request(t, http.MethodGet, "/api/v1/namespaces/default/pods/web-0/log?follow=true", nil, keyHeader("Authorization", "Bearer "+testKey))

	first := make(chan string, 1)
	go func() {
		buf := make([]byte, 64)
		n, _ := resp.Body.Read(buf)
		first <- string(buf[:n])
	}()
	select {
	case got := <-first:
		if got != "data: first line\n\n" {
			t.Fatalf("first chunk %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the first line was held back while the stream stayed open")
	}
}

func TestPassesAnUpgradeThrough(t *testing.T) {
	s := newStack(t)
	s.service.answer = func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "SPDY/3.1" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		conn, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: SPDY/3.1\r\n\r\n")
		_ = buffered.Flush()
		line, _ := buffered.ReadString('\n')
		_, _ = buffered.WriteString("echo " + line)
		_ = buffered.Flush()
	}

	conn, err := net.Dial("tcp", strings.TrimPrefix(s.url, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write([]byte("POST /api/v1/namespaces/default/pods/web-0/exec?command=sh HTTP/1.1\r\n" +
		"Host: k8s.external-services.opsiforce.test\r\n" +
		"Authorization: Bearer " + testKey + "\r\n" +
		"Connection: Upgrade\r\nUpgrade: SPDY/3.1\r\n\r\n"))
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status %d", resp.StatusCode)
	}
	_, _ = conn.Write([]byte("hello\n"))
	line, err := reader.ReadString('\n')
	if err != nil || line != "echo hello\n" {
		t.Fatalf("upgraded stream answered %q, %v", line, err)
	}
	if got := s.service.requests()[0].Header.Get("X-Opsiforce-Caller"); got != testIdentity {
		t.Fatalf("upgrade reached the service without the caller identity: %q", got)
	}
}

func TestForwardsOptionsAndAddsNoCORS(t *testing.T) {
	s := newStack(t)
	s.service.answer = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "GET, OPTIONS")
		w.WriteHeader(http.StatusNoContent)
	}
	header := http.Header{
		"Authorization":                 {"Bearer " + testKey},
		"Origin":                        {"https://evil.example"},
		"Access-Control-Request-Method": {"DELETE"},
	}
	resp := s.request(t, http.MethodOptions, "/repos/acme/web", nil, header)
	if resp.StatusCode != http.StatusNoContent || resp.Header.Get("Allow") != "GET, OPTIONS" {
		t.Fatalf("status %d allow %q", resp.StatusCode, resp.Header.Get("Allow"))
	}
	for name := range resp.Header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			t.Fatalf("the front gate added %s", name)
		}
	}
	got := s.service.requests()
	if len(got) != 1 || got[0].Method != http.MethodOptions || got[0].Header.Get("Origin") != "https://evil.example" {
		t.Fatalf("service received %+v", got)
	}
}

func TestOwnAnswers(t *testing.T) {
	bearer := keyHeader("Authorization", "Bearer "+testKey)

	t.Run("no key is 401 with a Basic challenge", func(t *testing.T) {
		s := newStack(t)
		resp := s.request(t, http.MethodGet, "/acme/web.git/info/refs?service=git-upload-pack", nil, keyHeader("Authorization", "Bearer ghp_not-a-gateway-key"))
		if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") != `Basic realm="Opsiforce"` {
			t.Fatalf("status %d challenge %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
		}
		messageOf(t, resp)
	})

	t.Run("an unknown or revoked key is 401 with the backend's message", func(t *testing.T) {
		s := newStack(t)
		s.platform.answer(http.StatusUnauthorized, "This Gateway Key is unknown or revoked.")
		resp := s.request(t, http.MethodGet, "/", nil, bearer)
		if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("WWW-Authenticate") != `Basic realm="Opsiforce"` {
			t.Fatalf("status %d challenge %q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
		}
		if got := messageOf(t, resp); got != "This Gateway Key is unknown or revoked." {
			t.Fatalf("message %q", got)
		}
	})

	for _, status := range []int{http.StatusNotFound, http.StatusBadGateway, http.StatusGatewayTimeout} {
		t.Run(fmt.Sprintf("the backend's %d is relayed", status), func(t *testing.T) {
			s := newStack(t)
			s.platform.answer(status, "GitHub is turned off in this Organization.")
			resp := s.request(t, http.MethodGet, "/", nil, bearer)
			if resp.StatusCode != status {
				t.Fatalf("status %d", resp.StatusCode)
			}
			if got := messageOf(t, resp); got != "GitHub is turned off in this Organization." {
				t.Fatalf("message %q", got)
			}
			if len(s.service.requests()) != 0 {
				t.Fatal("a refused call reached the service")
			}
		})
	}

	t.Run("a host with no service label is 404", func(t *testing.T) {
		s := newStack(t)
		req, _ := http.NewRequest(http.MethodGet, s.url+"/", nil)
		req.Host = "localhost"
		req.Header.Set("Authorization", "Bearer "+testKey)
		resp, err := rawClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status %d", resp.StatusCode)
		}
		messageOf(t, resp)
	})

	t.Run("a pod that refuses the connection is 502", func(t *testing.T) {
		s := newStack(t)
		s.serviceAt.Close()
		resp := s.request(t, http.MethodGet, "/", nil, bearer)
		if resp.StatusCode != http.StatusBadGateway {
			t.Fatalf("status %d", resp.StatusCode)
		}
		messageOf(t, resp)
	})

	t.Run("a pod not ready within the hold is 504", func(t *testing.T) {
		s := newStack(t, func(cfg *config.Config) { cfg.ServiceStartHold = 200 * time.Millisecond })
		s.platform.slowDown(5 * time.Second)
		started := time.Now()
		resp := s.request(t, http.MethodGet, "/", nil, bearer)
		if resp.StatusCode != http.StatusGatewayTimeout {
			t.Fatalf("status %d", resp.StatusCode)
		}
		if waited := time.Since(started); waited < 200*time.Millisecond || waited > 2*time.Second {
			t.Fatalf("answered after %v, want right after the 200 ms hold", waited)
		}
		messageOf(t, resp)
	})

	t.Run("the hold covers a slow wake", func(t *testing.T) {
		s := newStack(t, func(cfg *config.Config) { cfg.ServiceStartHold = 2 * time.Second })
		s.platform.slowDown(300 * time.Millisecond)
		resp := s.request(t, http.MethodGet, "/", nil, bearer)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d", resp.StatusCode)
		}
	})
}

func TestCachesTheResolveAnswerBriefly(t *testing.T) {
	bearer := keyHeader("Authorization", "Bearer "+testKey)

	t.Run("within its life one resolve serves many calls", func(t *testing.T) {
		s := newStack(t)
		for range 3 {
			s.request(t, http.MethodGet, "/", nil, bearer)
		}
		if calls := len(s.platform.resolveCalls()); calls != 1 {
			t.Fatalf("%d resolves, want 1", calls)
		}
	})

	t.Run("after its life the next call resolves again", func(t *testing.T) {
		s := newStack(t, func(cfg *config.Config) { cfg.CallerCacheTTL = 100 * time.Millisecond })
		s.request(t, http.MethodGet, "/", nil, bearer)
		time.Sleep(150 * time.Millisecond)
		s.request(t, http.MethodGet, "/", nil, bearer)
		if calls := len(s.platform.resolveCalls()); calls != 2 {
			t.Fatalf("%d resolves, want 2", calls)
		}
	})

	t.Run("another key or another service resolves on its own", func(t *testing.T) {
		s := newStack(t)
		s.request(t, http.MethodGet, "/", nil, bearer)
		s.request(t, http.MethodGet, "/", nil, keyHeader("Authorization", "Bearer gw-another-key"))
		req, _ := http.NewRequest(http.MethodGet, s.url+"/", nil)
		req.Host = "trello.external-services.opsiforce.test"
		req.Header.Set("Authorization", "Bearer "+testKey)
		resp, err := rawClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if calls := len(s.platform.resolveCalls()); calls != 3 {
			t.Fatalf("%d resolves, want 3", calls)
		}
	})

	t.Run("refusals are not cached", func(t *testing.T) {
		s := newStack(t)
		s.platform.answer(http.StatusNotFound, "There is no External Service \"github\" in this Organization.")
		s.request(t, http.MethodGet, "/", nil, bearer)
		s.platform.answer(http.StatusOK, "")
		if resp := s.request(t, http.MethodGet, "/", nil, bearer); resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d after the service appeared", resp.StatusCode)
		}
	})

	t.Run("a pod that refused the connection is resolved again", func(t *testing.T) {
		s := newStack(t)
		s.request(t, http.MethodGet, "/", nil, bearer)
		moved := httptest.NewServer(http.HandlerFunc(s.service.handler))
		t.Cleanup(moved.Close)
		s.serviceAt.Close()
		s.platform.mu.Lock()
		s.platform.upstream = moved.URL
		s.platform.mu.Unlock()
		if resp := s.request(t, http.MethodGet, "/", nil, bearer); resp.StatusCode != http.StatusBadGateway {
			t.Fatalf("status %d on the dead pod", resp.StatusCode)
		}
		if resp := s.request(t, http.MethodGet, "/", nil, bearer); resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d on the new pod", resp.StatusCode)
		}
	})
}

func TestTheBackendCanEvictTheCache(t *testing.T) {
	bearer := keyHeader("Authorization", "Bearer "+testKey)
	evict := func(t *testing.T, s *stack, token string, body string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, s.control+"/evict", strings.NewReader(body))
		req.Header.Set("x-proxy-control-token", token)
		resp, err := rawClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}

	t.Run("by Organization and slug", func(t *testing.T) {
		s := newStack(t)
		s.request(t, http.MethodGet, "/", nil, bearer)
		if status := evict(t, s, testControlToken, `{"tenantId":"`+testTenant+`","slug":"`+testSlug+`"}`); status != http.StatusNoContent {
			t.Fatalf("evict status %d", status)
		}
		s.platform.answer(http.StatusNotFound, "GitHub is turned off in this Organization.")
		if resp := s.request(t, http.MethodGet, "/", nil, bearer); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status %d right after Disable", resp.StatusCode)
		}
	})

	t.Run("by key", func(t *testing.T) {
		s := newStack(t)
		s.request(t, http.MethodGet, "/", nil, bearer)
		if status := evict(t, s, testControlToken, `{"gatewayKey":"`+testKey+`"}`); status != http.StatusNoContent {
			t.Fatalf("evict status %d", status)
		}
		s.platform.answer(http.StatusUnauthorized, "This Gateway Key is unknown or revoked.")
		if resp := s.request(t, http.MethodGet, "/", nil, bearer); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status %d right after Rotate", resp.StatusCode)
		}
	})

	t.Run("another Organization's entry stays", func(t *testing.T) {
		s := newStack(t)
		s.request(t, http.MethodGet, "/", nil, bearer)
		evict(t, s, testControlToken, `{"tenantId":"tenant-2","slug":"`+testSlug+`"}`)
		s.request(t, http.MethodGet, "/", nil, bearer)
		if calls := len(s.platform.resolveCalls()); calls != 1 {
			t.Fatalf("%d resolves, want 1", calls)
		}
	})

	t.Run("a resolve in flight during an eviction is not cached", func(t *testing.T) {
		s := newStack(t)
		s.platform.slowDown(300 * time.Millisecond)
		done := make(chan struct{})
		go func() {
			defer close(done)
			req, _ := http.NewRequest(http.MethodGet, s.url+"/", nil)
			req.Host = testSlug + ".external-services.opsiforce.test"
			req.Header.Set("Authorization", "Bearer "+testKey)
			if resp, err := rawClient.Do(req); err == nil {
				_ = resp.Body.Close()
			}
		}()
		time.Sleep(100 * time.Millisecond)
		evict(t, s, testControlToken, `{"tenantId":"`+testTenant+`","slug":"`+testSlug+`"}`)
		<-done
		s.platform.slowDown(0)
		s.request(t, http.MethodGet, "/", nil, bearer)
		if calls := len(s.platform.resolveCalls()); calls != 2 {
			t.Fatalf("%d resolves, want 2", calls)
		}
	})

	t.Run("needs the control token and a target", func(t *testing.T) {
		s := newStack(t)
		if status := evict(t, s, "wrong", `{"gatewayKey":"`+testKey+`"}`); status != http.StatusForbidden {
			t.Fatalf("wrong token status %d", status)
		}
		if status := evict(t, s, testControlToken, `{"slug":"`+testSlug+`"}`); status != http.StatusBadRequest {
			t.Fatalf("slug alone status %d", status)
		}
	})

	t.Run("the control port answers health, the Service host does not", func(t *testing.T) {
		s := newStack(t)
		resp, err := rawClient.Get(s.control + "/health")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("control health status %d", resp.StatusCode)
		}
		s.request(t, http.MethodGet, "/health", nil, bearer)
		if got := s.service.requests(); len(got) != 1 || got[0].RequestURI != "/health" {
			t.Fatalf("a service's own /health was not forwarded: %+v", got)
		}
	})
}

func TestSendsABuiltInsCallsIntoTheBackendsBuiltInsAdapter(t *testing.T) {
	s := newStack(t)
	s.platform.serveBuiltIn("/api/internal/external-services/built-ins/github")

	resp := s.request(t, http.MethodGet, "/address/a%2Fb?x=1", nil, http.Header{
		"Authorization":      {"Bearer " + testKey},
		"X-Opsiforce-Caller": {"forged"},
	})

	if resp.StatusCode != http.StatusOK || readAll(t, resp) != "from the service" {
		t.Fatalf("answer = %d", resp.StatusCode)
	}
	got := s.service.requests()
	if len(got) != 1 || got[0].RequestURI != "/api/internal/external-services/built-ins/github/address/a%2Fb?x=1" {
		t.Fatalf("forwarded = %+v", got)
	}
	if got[0].Header.Get("Authorization") != "" || got[0].Header.Values("X-Opsiforce-Caller")[0] != testIdentity {
		t.Fatalf("headers at the adapter: %v", got[0].Header)
	}
}

func TestClosesAnIdleConnectionBeforeTheServiceServerDoes(t *testing.T) {
	const sdkServerIdleTimeout = 75 * time.Second
	gate := New(config.Config{Mode: config.ModeExternalService}, backend.New("http://backend.invalid", testControlToken, time.Second))
	t.Cleanup(gate.Close)

	if got := gate.transport.IdleConnTimeout; got <= 0 || got >= sdkServerIdleTimeout {
		t.Fatalf("IdleConnTimeout = %v, want shorter than the SDK server's %v keep-alive", got, sdkServerIdleTimeout)
	}
}
