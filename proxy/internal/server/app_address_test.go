package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/config"
)

const readableAppHost = "warehouse-dev-111111112222.apps.test"

type appEnsureCall struct {
	Host           string
	Authorization  string
	ForwardedUser  string
	Cookie         string
	ReservedHeader bool
}

type appControlPlane struct {
	mu           sync.Mutex
	answer       backend.EnsureResponse
	notFound     bool
	ensures      []appEnsureCall
	controlPaths []string
}

func (c *appControlPlane) handler(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if r.URL.Path != "/api/internal/proxy/apps/ensure" {
		c.controlPaths = append(c.controlPaths, r.URL.Path)
		if strings.HasSuffix(r.URL.Path, "/failure") {
			_, _ = w.Write([]byte(`{"restart":false}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	var body struct {
		Host string `json:"host"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	reserved := false
	for name := range r.Header {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
			reserved = true
		}
	}
	c.ensures = append(c.ensures, appEnsureCall{
		Host:           body.Host,
		Authorization:  r.Header.Get("authorization"),
		ForwardedUser:  r.Header.Get("x-forwarded-user"),
		Cookie:         r.Header.Get("cookie"),
		ReservedHeader: reserved,
	})

	if c.notFound {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"No App answers on ` + body.Host + `"}`))
		return
	}
	_ = json.NewEncoder(w).Encode(c.answer)
}

func (c *appControlPlane) ensureCalls() []appEnsureCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]appEnsureCall(nil), c.ensures...)
}

func (c *appControlPlane) controlCalls() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.controlPaths...)
}

type recordingUpstream struct {
	mu       sync.Mutex
	requests []*http.Request
}

func (u *recordingUpstream) handler(w http.ResponseWriter, r *http.Request) {
	u.mu.Lock()
	u.requests = append(u.requests, r.Clone(r.Context()))
	u.mu.Unlock()
	_, _ = w.Write([]byte("app says hi"))
}

func (u *recordingUpstream) received() []*http.Request {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]*http.Request(nil), u.requests...)
}

func startUpstream(t *testing.T) (*recordingUpstream, string) {
	t.Helper()
	upstream := &recordingUpstream{}
	server := httptest.NewServer(http.HandlerFunc(upstream.handler))
	t.Cleanup(server.Close)
	return upstream, server.URL
}

func serveAnswer(upstream string) backend.EnsureResponse {
	return backend.EnsureResponse{
		Action:        "serve",
		State:         "ready",
		Upstream:      upstream,
		EnvironmentID: testEnvironmentID,
		CanonicalHost: testEnvironmentID + "-dev.apps.test",
	}
}

func newAppServer(t *testing.T, plane *appControlPlane) *Server {
	t.Helper()
	control := httptest.NewServer(http.HandlerFunc(plane.handler))
	t.Cleanup(control.Close)

	return New(
		config.Config{
			Mode:                        config.ModeApp,
			ReadyCacheTTL:               time.Minute,
			NonReadyCacheTTL:            time.Minute,
			ControlPlaneTimeout:         5 * time.Second,
			WebsocketKeepAliveInterval:  time.Minute,
			AppAuthForwardingSigningKey: strings.Repeat("k", 32),
		},
		backend.New(control.URL, "token", 5*time.Second),
		nil,
	)
}

func visit(server *Server, target string, headers http.Header) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for name, values := range headers {
		req.Header[name] = values
	}
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	return rec
}

func TestTheFullHostReachesTheBackendAndAServeAnswerIsProxied(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	headers := http.Header{}
	headers.Set("x-forwarded-user", "alice")
	headers.Set("cookie", "session=secret")
	rec := visit(server, "https://"+readableAppHost+":443/orders?id=7", headers)

	if rec.Code != http.StatusOK || rec.Body.String() != "app says hi" {
		t.Fatalf("got %d %q, want the upstream's 200", rec.Code, rec.Body.String())
	}
	calls := plane.ensureCalls()
	if len(calls) != 1 {
		t.Fatalf("ensure calls: got %d want 1", len(calls))
	}
	want := appEnsureCall{Host: readableAppHost + ":443", ForwardedUser: "alice"}
	if calls[0] != want {
		t.Errorf("ensure call: got %+v want %+v", calls[0], want)
	}
	received := upstream.received()
	if len(received) != 1 || received[0].URL.RequestURI() != "/orders?id=7" {
		t.Fatalf("upstream requests: %+v", received)
	}
}

func TestARedirectAnswerSendsThePermanentRedirectKeepingPathAndQuery(t *testing.T) {
	upstream, _ := startUpstream(t)
	plane := &appControlPlane{answer: backend.EnsureResponse{
		Action:        "redirect",
		EnvironmentID: testEnvironmentID,
		CanonicalHost: testEnvironmentID + "-dev.apps.test",
	}}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/orders?id=7", nil)

	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("got %d want 308", rec.Code)
	}
	if got, want := rec.Header().Get("Location"), "https://"+testEnvironmentID+"-dev.apps.test/orders?id=7"; got != want {
		t.Errorf("Location: got %q want %q", got, want)
	}
	if len(upstream.received()) != 0 {
		t.Error("a redirect reached the App")
	}
}

func TestARedirectIsNeverStoredByTheBrowser(t *testing.T) {
	plane := &appControlPlane{answer: backend.EnsureResponse{
		Action:        "redirect",
		EnvironmentID: testEnvironmentID,
		CanonicalHost: testEnvironmentID + "-dev.apps.test",
	}}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/", nil)

	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("got %d want 308", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control: got %q want no-store, so a later Edit URL back cannot loop", got)
	}
}

func TestAPreviewHostReachesTheBackendWholeAndIsServed(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)
	previewHost := testEnvironmentID + ".preview.apps.test"

	rec := visit(server, "https://"+previewHost+"/", nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want the upstream's 200", rec.Code)
	}
	if calls := plane.ensureCalls(); len(calls) != 1 || calls[0].Host != previewHost {
		t.Errorf("ensure calls: %+v", calls)
	}
	if len(upstream.received()) != 1 {
		t.Error("the preview request did not reach the App")
	}
}

func TestARedirectAnswerIsCachedOnlyAsLongAsAStartingOne(t *testing.T) {
	plane := &appControlPlane{answer: backend.EnsureResponse{
		Action:        "redirect",
		EnvironmentID: testEnvironmentID,
		CanonicalHost: testEnvironmentID + "-dev.apps.test",
	}}
	server := newAppServer(t, plane)
	server.cfg.NonReadyCacheTTL = 0

	for range 2 {
		if rec := visit(server, "https://"+readableAppHost+"/", nil); rec.Code != http.StatusPermanentRedirect {
			t.Fatalf("got %d want 308", rec.Code)
		}
	}

	if calls := len(plane.ensureCalls()); calls != 2 {
		t.Errorf("ensure calls: got %d want 2, the redirect was not cached past the starting TTL", calls)
	}
}

func TestAHostNoAppAnswersOnPassesTheBackends404Through(t *testing.T) {
	plane := &appControlPlane{notFound: true}
	server := newAppServer(t, plane)

	rec := visit(server, "https://nothing-here.apps.test/", nil)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d want 404", rec.Code)
	}
	if calls := plane.ensureCalls(); len(calls) != 1 || calls[0].Host != "nothing-here.apps.test" {
		t.Errorf("ensure calls: %+v", calls)
	}
}

func TestAForwardingProofForTheAnsweredEnvironmentReachesTheApp(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/orders", forwardingFixture(testEnvironmentID))

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control: got %q want no-store", got)
	}
	received := upstream.received()
	if len(received) != 1 || received[0].Header.Get(forwardedTokenHeader) != "user-token" {
		t.Fatalf("the App did not receive the forwarded token: %+v", received)
	}
	if received[0].Header.Get(forwardingProofHeader) != "" {
		t.Error("the forwarding proof reached the App")
	}
	if plane.ensureCalls()[0].ReservedHeader {
		t.Error("a reserved header reached the backend")
	}
}

func TestAForwardingProofForAnotherEnvironmentIsStrippedAndTheRequestProceeds(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/orders", forwardingFixture("99999999-2222-3333-4444-555555555555"))

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200", rec.Code)
	}
	received := upstream.received()
	if len(received) != 1 {
		t.Fatalf("upstream requests: got %d want 1", len(received))
	}
	for name := range received[0].Header {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
			t.Errorf("reserved header %q reached the App", name)
		}
	}
	if got := rec.Header().Get("Cache-Control"); got == "no-store" {
		t.Error("an unforwarded request was marked no-store")
	}
}

func TestACrossOriginForwardedRequestIsRefused(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	headers := forwardingFixture(testEnvironmentID)
	headers.Set("Origin", "https://evil.example")
	rec := visit(server, "https://"+readableAppHost+"/orders", headers)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403", rec.Code)
	}
	if len(upstream.received()) != 0 {
		t.Error("a cross-origin forwarded request reached the App")
	}
}

func TestVisitorsShareTheCachedAnswerForAHost(t *testing.T) {
	_, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	for _, user := range []string{"alice", "bob", ""} {
		headers := http.Header{}
		if user != "" {
			headers.Set("x-forwarded-user", user)
		}
		if rec := visit(server, "https://"+readableAppHost+"/", headers); rec.Code != http.StatusOK {
			t.Fatalf("%q: got %d want 200", user, rec.Code)
		}
	}

	if calls := len(plane.ensureCalls()); calls != 1 {
		t.Errorf("ensure calls: got %d want 1", calls)
	}
}

func TestAGatewayKeyRequestSkipsTheCachedAnswer(t *testing.T) {
	_, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	headers := http.Header{}
	headers.Set("authorization", "Bearer gw-pod")
	for range 2 {
		if rec := visit(server, "https://"+readableAppHost+"/", headers); rec.Code != http.StatusOK {
			t.Fatalf("got %d want 200", rec.Code)
		}
	}

	calls := plane.ensureCalls()
	if len(calls) != 2 {
		t.Fatalf("ensure calls: got %d want 2, one per keyed request", len(calls))
	}
	if calls[0].Authorization != "Bearer gw-pod" {
		t.Errorf("authorization: got %q", calls[0].Authorization)
	}
}

func TestAFailedRequestIsReportedForTheAnsweredEnvironmentAndDropsItsCachedAnswer(t *testing.T) {
	plane := &appControlPlane{answer: serveAnswer("http://127.0.0.1:1")}
	server := newAppServer(t, plane)

	for range 2 {
		if rec := visit(server, "https://"+readableAppHost+"/", nil); rec.Code != http.StatusBadGateway {
			t.Fatalf("got %d want 502", rec.Code)
		}
	}

	failure := "/api/internal/proxy/projects/" + testEnvironmentID + "/failure"
	if paths := plane.controlCalls(); len(paths) != 2 || paths[0] != failure || paths[1] != failure {
		t.Errorf("control calls: got %v want two %q", paths, failure)
	}
	if calls := len(plane.ensureCalls()); calls != 2 {
		t.Errorf("ensure calls: got %d want 2, the failure dropped the cached answer", calls)
	}
}

func TestALiveUpgradedConnectionTouchesTheAnsweredEnvironment(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffered.Flush()
		_, _ = io.Copy(io.Discard, conn)
	}))
	t.Cleanup(upstream.Close)
	plane := &appControlPlane{answer: serveAnswer(upstream.URL)}
	proxy := httptest.NewServer(newAppServer(t, plane))
	t.Cleanup(proxy.Close)

	conn, err := net.Dial("tcp", proxy.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_, _ = conn.Write([]byte("GET /socket HTTP/1.1\r\nHost: " + readableAppHost + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("got %d want 101", resp.StatusCode)
	}

	activity := "/api/internal/proxy/projects/" + testEnvironmentID + "/activity"
	if !waitFor(t, time.Second, func() bool { return slices.Contains(plane.controlCalls(), activity) }) {
		t.Errorf("control calls: got %v want %q", plane.controlCalls(), activity)
	}
}

func protectedServeAnswer(upstream string) backend.EnsureResponse {
	answer := serveAnswer(upstream)
	answer.Protected = true
	return answer
}

func markedAsUnprotectedRoute() http.Header {
	headers := http.Header{}
	headers.Set(unprotectedRouteHeader, "1")
	return headers
}

func captureWarnings(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &logs
}

func TestAProtectedAppReachedThroughTheUnprotectedRouteIsRefusedWithoutContactingThePod(t *testing.T) {
	logs := captureWarnings(t)
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: protectedServeAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/orders", markedAsUnprotectedRoute())

	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q want application/json", got)
	}
	if len(upstream.received()) != 0 {
		t.Error("a protected App was served through the unprotected route")
	}
	if paths := plane.controlCalls(); len(paths) != 0 {
		t.Errorf("control calls: got %v want none", paths)
	}
	if !strings.Contains(logs.String(), "environmentId="+testEnvironmentID) {
		t.Errorf("warning does not name the environment: %q", logs.String())
	}
}

func TestASignedInUpgradeFromAnotherOriginIsRefusedWithoutContactingThePod(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: protectedServeAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	headers := http.Header{}
	headers.Set("Connection", "Upgrade")
	headers.Set("Upgrade", "websocket")
	headers.Set("Origin", "https://sibling-dev-0123456789ab.apps.test")
	headers.Set(signedInSubjectHeader, "visitor-1")
	rec := visit(server, "https://"+readableAppHost+"/socket", headers)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("a refused cross-origin upgrade carries CORS permission")
	}
	if len(upstream.received()) != 0 || len(plane.ensureCalls()) != 0 {
		t.Error("a signed-in upgrade from another origin reached the control plane or the pod")
	}
}

func TestASignedInUpgradeFromTheAppsOwnOriginReachesThePod(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: protectedServeAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	headers := http.Header{}
	headers.Set("Connection", "Upgrade")
	headers.Set("Upgrade", "websocket")
	headers.Set("Origin", "https://"+readableAppHost)
	headers.Set(signedInSubjectHeader, "visitor-1")
	visit(server, "https://"+readableAppHost+"/socket", headers)

	if len(upstream.received()) != 1 {
		t.Fatalf("upstream requests: got %d want 1", len(upstream.received()))
	}
}

func TestAProtectedAppReachedThroughItsOwnRouteIsServed(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: protectedServeAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/orders", nil)

	if rec.Code != http.StatusOK || len(upstream.received()) != 1 {
		t.Fatalf("got %d with %d upstream requests, want the upstream's 200", rec.Code, len(upstream.received()))
	}
}

func TestAPublicAppReachedThroughTheUnprotectedRouteIsServedWithoutTheMarker(t *testing.T) {
	upstream, upstreamURL := startUpstream(t)
	plane := &appControlPlane{answer: serveAnswer(upstreamURL)}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+readableAppHost+"/orders", markedAsUnprotectedRoute())

	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want the upstream's 200", rec.Code)
	}
	received := upstream.received()
	if len(received) != 1 {
		t.Fatalf("upstream requests: got %d want 1", len(received))
	}
	for name := range received[0].Header {
		if strings.EqualFold(name, unprotectedRouteHeader) {
			t.Error("the unprotected-route marker reached the App")
		}
	}
	if plane.ensureCalls()[0].ReservedHeader {
		t.Error("the unprotected-route marker reached the backend")
	}
}

func TestAProtectedAppsRedirectThroughTheUnprotectedRouteIsRefusedWithoutNamingTheApp(t *testing.T) {
	plane := &appControlPlane{answer: backend.EnsureResponse{
		Action:        "redirect",
		EnvironmentID: testEnvironmentID,
		CanonicalHost: readableAppHost,
		Protected:     true,
	}}
	server := newAppServer(t, plane)

	rec := visit(server, "https://"+testEnvironmentID+"-prod.apps.test/orders", markedAsUnprotectedRoute())

	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403", rec.Code)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Errorf("Location: got %q, the refusal named the App", location)
	}
	if strings.Contains(rec.Body.String(), readableAppHost) {
		t.Errorf("body names the App: %q", rec.Body.String())
	}
}
