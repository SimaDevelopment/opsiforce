package gate

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/config"
)

type webhookResolveCall struct {
	Service     string
	Development bool
	Token       string
}

type fakeWebhookPlatform struct {
	mu        sync.Mutex
	calls     []webhookResolveCall
	upstream  string
	servedBy  string
	status    int
	message   string
	forwarded []receivedRequest
}

func (p *fakeWebhookPlatform) handler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/internal/proxy/external-services/resolve-webhook" {
		body, _ := io.ReadAll(r.Body)
		p.mu.Lock()
		p.forwarded = append(p.forwarded, receivedRequest{Method: r.Method, RequestURI: r.RequestURI, Host: r.Host, Header: r.Header.Clone(), Body: body})
		p.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"received":true}`))
		return
	}
	var body struct {
		Service     string `json:"service"`
		Development bool   `json:"development"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	p.mu.Lock()
	p.calls = append(p.calls, webhookResolveCall{Service: body.Service, Development: body.Development, Token: r.Header.Get("x-proxy-control-token")})
	status, message, upstream, servedBy := p.status, p.message, p.upstream, p.servedBy
	p.mu.Unlock()
	w.Header().Set("content-type", "application/json")
	if status != 0 && status != http.StatusOK {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
		return
	}
	if servedBy == "built-in" {
		upstream = "/api/internal/external-services/built-ins/incoming-email"
	}
	_ = json.NewEncoder(w).Encode(map[string]string{
		"servedBy":       servedBy,
		"upstream":       upstream,
		"callerIdentity": testIdentity,
		"tenantId":       testTenant,
		"serviceId":      "service-1",
		"slug":           testSlug,
	})
}

func (p *fakeWebhookPlatform) resolveCalls() []webhookResolveCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]webhookResolveCall(nil), p.calls...)
}

func (p *fakeWebhookPlatform) forwardedRequests() []receivedRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]receivedRequest(nil), p.forwarded...)
}

type webhookStack struct {
	platform *fakeWebhookPlatform
	service  *fakeService
	url      string
	control  string
}

func newWebhookStack(t *testing.T, servedBy string) *webhookStack {
	t.Helper()
	service := &fakeService{}
	serviceAt := httptest.NewServer(http.HandlerFunc(service.handler))
	t.Cleanup(serviceAt.Close)

	platform := &fakeWebhookPlatform{upstream: serviceAt.URL, servedBy: servedBy}
	platformAt := httptest.NewServer(http.HandlerFunc(platform.handler))
	t.Cleanup(platformAt.Close)

	cfg := config.Config{
		Mode:              config.ModeExternalService,
		BackendURL:        platformAt.URL,
		ProxyControlToken: testControlToken,
		ServiceStartHold:  5 * time.Second,
		CallerCacheTTL:    5 * time.Second,
	}
	gate := New(cfg, backend.New(platformAt.URL, testControlToken, time.Second))
	laneAt := httptest.NewServer(gate.WebhookHandler())
	t.Cleanup(laneAt.Close)
	controlAt := httptest.NewServer(gate.ControlHandler())
	t.Cleanup(controlAt.Close)
	t.Cleanup(func() { gate.Close() })
	return &webhookStack{platform: platform, service: service, url: laneAt.URL, control: controlAt.URL}
}

func (s *webhookStack) request(t *testing.T, method string, path string, body io.Reader, header http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, s.url+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "opsiforce.test"
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

func assertSandboxed(t *testing.T, resp *http.Response) {
	t.Helper()
	if got := resp.Header.Values("Content-Security-Policy"); len(got) != 1 || got[0] != "sandbox" {
		t.Fatalf("Content-Security-Policy = %q, want exactly sandbox", got)
	}
	if got := resp.Header.Values("X-Content-Type-Options"); len(got) != 1 || got[0] != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want exactly nosniff", got)
	}
}

func TestWebhookLaneForwardsAnyMethodAndSubPathToTheWebhookHandler(t *testing.T) {
	stack := newWebhookStack(t, "pod")

	cases := []struct {
		method string
		path   string
		want   string
	}{
		{http.MethodPost, "/api/external-services/webhooks/service-1", "/.well-known/opsiforce/webhook"},
		{http.MethodGet, "/api/external-services/webhooks/service-1/meta/verify?hub.mode=subscribe&hub.challenge=42", "/.well-known/opsiforce/webhook/meta/verify?hub.mode=subscribe&hub.challenge=42"},
		{http.MethodPut, "/api/external-services/webhooks/service-1/a%2Fb/c", "/.well-known/opsiforce/webhook/a%2Fb/c"},
		{http.MethodDelete, "/api/external-services/webhooks/service-1/", "/.well-known/opsiforce/webhook/"},
	}
	for _, c := range cases {
		resp := stack.request(t, c.method, c.path, strings.NewReader("payload"), nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s %s answered %d", c.method, c.path, resp.StatusCode)
		}
	}

	received := stack.service.requests()
	if len(received) != len(cases) {
		t.Fatalf("service got %d requests, want %d", len(received), len(cases))
	}
	for i, c := range cases {
		if received[i].Method != c.method || received[i].RequestURI != c.want {
			t.Fatalf("request %d reached the pod as %s %s, want %s %s", i, received[i].Method, received[i].RequestURI, c.method, c.want)
		}
		if received[i].Host != "opsiforce.test" {
			t.Fatalf("Host = %q, want the main host", received[i].Host)
		}
	}
	if string(received[0].Body) != "payload" {
		t.Fatalf("body = %q", received[0].Body)
	}
}

func TestWebhookLaneNamesDevelopmentAndCachesTheResolve(t *testing.T) {
	stack := newWebhookStack(t, "pod")

	stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1/development/github", nil, nil)
	stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1/development", nil, nil)
	stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1", nil, nil)

	calls := stack.platform.resolveCalls()
	want := []webhookResolveCall{
		{Service: "service-1", Development: true, Token: testControlToken},
		{Service: "service-1", Development: false, Token: testControlToken},
	}
	if len(calls) != len(want) || calls[0] != want[0] || calls[1] != want[1] {
		t.Fatalf("resolve calls = %+v, want %+v", calls, want)
	}
	received := stack.service.requests()
	if received[0].RequestURI != "/.well-known/opsiforce/webhook/github" || received[1].RequestURI != "/.well-known/opsiforce/webhook" {
		t.Fatalf("pod paths = %q, %q", received[0].RequestURI, received[1].RequestURI)
	}
}

func TestWebhookLaneKeepsAuthorizationDropsCookieAndReservedHeadersAndAddsThePlatformIdentity(t *testing.T) {
	stack := newWebhookStack(t, "pod")

	resp := stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1", strings.NewReader("{}"), http.Header{
		"Authorization":       {"Bearer provider-token"},
		"Cookie":              {"_oauth2_proxy=session"},
		"X-Opsiforce-Caller":  {"forged"},
		"X-Opsiforce-Other":   {"forged"},
		"X-Hub-Signature-256": {"sha256=abc"},
	})
	assertSandboxed(t, resp)

	got := stack.service.requests()[0].Header
	if got.Get("Authorization") != "Bearer provider-token" {
		t.Fatalf("Authorization = %q", got.Get("Authorization"))
	}
	if got.Get("Cookie") != "" {
		t.Fatalf("Cookie reached the pod: %q", got.Get("Cookie"))
	}
	if got.Get("X-Opsiforce-Other") != "" || got.Values("X-Opsiforce-Caller")[0] != testIdentity || len(got.Values("X-Opsiforce-Caller")) != 1 {
		t.Fatalf("reserved headers at the pod: %v", got)
	}
	if got.Get("X-Hub-Signature-256") != "sha256=abc" {
		t.Fatalf("provider header lost: %v", got)
	}
}

func TestWebhookLaneSandboxesEveryAnswerReplacesTheServicesOwnAndDropsItsCookies(t *testing.T) {
	stack := newWebhookStack(t, "pod")
	stack.service.answer = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src *")
		w.Header().Set("Content-Type", "text/html")
		w.Header().Add("Set-Cookie", "_oauth2_proxy=attacker; Path=/; Secure; HttpOnly")
		w.Header().Set("Clear-Site-Data", `"cookies"`)
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("<b>hi</b>"))
	}

	resp := stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1", nil, nil)

	if resp.StatusCode != http.StatusAccepted || readAll(t, resp) != "<b>hi</b>" {
		t.Fatalf("answer changed: %d", resp.StatusCode)
	}
	assertSandboxed(t, resp)
	if resp.Header.Get("Content-Type") != "text/html" {
		t.Fatalf("headers changed: %v", resp.Header)
	}
	if resp.Header.Get("Set-Cookie") != "" || resp.Header.Get("Clear-Site-Data") != "" {
		t.Fatalf("the service changed the platform origin's cookies: %v", resp.Header)
	}
}

func TestWebhookLaneOwnAnswersAreSandboxedMessages(t *testing.T) {
	stack := newWebhookStack(t, "pod")
	stack.platform.mu.Lock()
	stack.platform.status, stack.platform.message = http.StatusNotFound, "Boards does not receive webhooks."
	stack.platform.mu.Unlock()

	refused := stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1", nil, nil)
	wrongPath := stack.request(t, http.MethodPost, "/api/v1/projects", nil, nil)

	for _, resp := range []*http.Response{refused, wrongPath} {
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		assertSandboxed(t, resp)
	}
	if body := readAll(t, refused); !strings.Contains(body, "does not receive webhooks") {
		t.Fatalf("body = %s", body)
	}
	if len(stack.platform.resolveCalls()) != 1 {
		t.Fatalf("a path outside the Webhook address was resolved")
	}
}

func TestEvictingAServiceDropsItsWebhookResolve(t *testing.T) {
	stack := newWebhookStack(t, "pod")
	stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1", nil, nil)

	req, _ := http.NewRequest(http.MethodPost, stack.control+"/evict", strings.NewReader(`{"tenantId":"`+testTenant+`","slug":"`+testSlug+`"}`))
	req.Header.Set("x-proxy-control-token", testControlToken)
	resp, err := rawClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("evict: %v %v", err, resp)
	}
	stack.request(t, http.MethodPost, "/api/external-services/webhooks/service-1", nil, nil)

	if calls := len(stack.platform.resolveCalls()); calls != 2 {
		t.Fatalf("resolve calls = %d, want 2", calls)
	}
}

func TestWebhookLaneSendsBuiltInsIntoTheBackendsBuiltInsAdapter(t *testing.T) {
	stack := newWebhookStack(t, "built-in")

	resp := stack.request(t, http.MethodPost, "/api/external-services/webhooks/incoming-email/inbound/mail?x=1", strings.NewReader("mail"), http.Header{
		"Cookie":             {"session=1"},
		"X-Opsiforce-Caller": {"forged"},
	})

	assertSandboxed(t, resp)
	forwarded := stack.platform.forwardedRequests()
	if len(forwarded) != 1 || forwarded[0].RequestURI != "/api/internal/external-services/built-ins/incoming-email/.well-known/opsiforce/webhook/inbound/mail?x=1" || string(forwarded[0].Body) != "mail" {
		t.Fatalf("forwarded = %+v", forwarded)
	}
	if forwarded[0].Header.Get("Cookie") != "" || forwarded[0].Header.Values("X-Opsiforce-Caller")[0] != testIdentity {
		t.Fatalf("headers at the adapter: %v", forwarded[0].Header)
	}
	if len(stack.service.requests()) != 0 {
		t.Fatalf("a built-in's webhook reached a pod")
	}
}

func TestWebhookLaneKeepsTheWebhookSecretHeaderWhatsAppRegistered(t *testing.T) {
	stack := newWebhookStack(t, "built-in")

	stack.request(t, http.MethodPost, "/api/external-services/webhooks/whatsapp", strings.NewReader("{}"), http.Header{
		"X-Opsiforce-Webhook-Secret": {"number-secret"},
	})

	forwarded := stack.platform.forwardedRequests()
	if len(forwarded) != 1 || forwarded[0].Header.Get("X-Opsiforce-Webhook-Secret") != "number-secret" {
		t.Fatalf("forwarded = %+v", forwarded)
	}
}
