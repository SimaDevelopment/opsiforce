package server

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
)

func browserNavigation() http.Header {
	headers := http.Header{}
	headers.Set("Sec-Fetch-Mode", "navigate")
	headers.Set("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
	return headers
}

func stateAnswer(state string) backend.EnsureResponse {
	answer := serveAnswer("http://127.0.0.1:1")
	answer.State = state
	return answer
}

func TestABrowserOpeningAnAppThatCannotAnswerSeesAPageInsteadOfJSON(t *testing.T) {
	cases := []struct {
		name   string
		plane  *appControlPlane
		status int
		title  string
		checks bool
	}{
		{"unresponsive", &appControlPlane{answer: serveAnswer("http://127.0.0.1:1")}, http.StatusBadGateway, "This App isn&#39;t responding", true},
		{"starting", &appControlPlane{answer: stateAnswer("starting")}, http.StatusServiceUnavailable, "Starting up", true},
		{"failed", &appControlPlane{answer: stateAnswer("failed")}, http.StatusBadGateway, "This App couldn&#39;t start", false},
		{"disabled", &appControlPlane{answer: stateAnswer("disabled")}, http.StatusLocked, "This App is turned off", false},
		{"unknown host", &appControlPlane{notFound: true}, http.StatusNotFound, "App not found", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := visit(newAppServer(t, tc.plane), "https://"+readableAppHost+"/", browserNavigation())

			if rec.Code != tc.status {
				t.Fatalf("got %d want %d", rec.Code, tc.status)
			}
			if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
				t.Errorf("Content-Type: got %q", got)
			}
			if got := rec.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control: got %q want no-store", got)
			}
			body := rec.Body.String()
			if !strings.Contains(body, "<h1>"+tc.title+"</h1>") {
				t.Errorf("page does not carry the title %q: %s", tc.title, body)
			}
			if checks := strings.Contains(body, "fetch(location.href"); checks != tc.checks {
				t.Errorf("page checks the App in the background: got %v want %v", checks, tc.checks)
			}
		})
	}
}

func TestAPageGivesUpOnACheckThatNeverAnswers(t *testing.T) {
	rec := visit(newAppServer(t, &appControlPlane{answer: serveAnswer("http://127.0.0.1:1")}), "https://"+readableAppHost+"/", browserNavigation())

	if !strings.Contains(rec.Body.String(), "signal: AbortSignal.timeout(") {
		t.Errorf("the page's check has no deadline, so an App that never answers stalls it: %s", rec.Body.String())
	}
}

func TestAStartingPageKeepsTheRetryAfterHeader(t *testing.T) {
	rec := visit(newAppServer(t, &appControlPlane{answer: stateAnswer("starting")}), "https://"+readableAppHost+"/", browserNavigation())

	if got := rec.Header().Get(retryAfterHeader); got != strconv.Itoa(restartRetryAfterSeconds) {
		t.Errorf("Retry-After: got %q want %d", got, restartRetryAfterSeconds)
	}
}

func TestAnAppsOwnFetchStillGetsTheJSONError(t *testing.T) {
	headers := http.Header{}
	headers.Set("Sec-Fetch-Mode", "cors")
	headers.Set("Accept", "*/*")

	rec := visit(newAppServer(t, &appControlPlane{answer: serveAnswer("http://127.0.0.1:1")}), "https://"+readableAppHost+"/api/orders", headers)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d want 502", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q want application/json", got)
	}
	if got := rec.Body.String(); got != string(badGatewayBody) {
		t.Errorf("body: got %q want %q", got, badGatewayBody)
	}
}

func TestABrowserWithoutFetchMetadataIsRecognisedByItsAcceptHeader(t *testing.T) {
	headers := http.Header{}
	headers.Set("Accept", "text/html,application/xhtml+xml")

	rec := visit(newAppServer(t, &appControlPlane{answer: serveAnswer("http://127.0.0.1:1")}), "https://"+readableAppHost+"/", headers)

	if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Errorf("Content-Type: got %q want the page", got)
	}
}

func TestAFormPostToAnAppThatCannotAnswerGetsJSON(t *testing.T) {
	server := newAppServer(t, &appControlPlane{answer: serveAnswer("http://127.0.0.1:1")})
	req := httptest.NewRequest(http.MethodPost, "https://"+readableAppHost+"/orders", strings.NewReader("a=1"))
	req.Header = browserNavigation()
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q want application/json", got)
	}
}

func TestOtherSurfacesKeepTheirJSONErrorForANavigation(t *testing.T) {
	server := newAgentServer(t, &controlPlane{allowed: map[string]bool{"alice": true}, upstream: "http://127.0.0.1:1"})
	req := agentRequest("alice", "")
	for name, values := range browserNavigation() {
		req.Header[name] = values
	}
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d want 502", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q want application/json", got)
	}
}

func appServerWhoseEnsureFails(t *testing.T) *Server {
	t.Helper()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"statusCode":500,"message":"Internal server error"}`))
	}))
	t.Cleanup(control.Close)
	server := newAppServer(t, &appControlPlane{})
	server.backend = backend.New(control.URL, "token", 5*time.Second)
	return server
}

func TestABrowserOpeningAnAppWhileEnsureFailsSeesTheNotRespondingPage(t *testing.T) {
	server := appServerWhoseEnsureFails(t)

	page := visit(server, "https://"+readableAppHost+"/", browserNavigation())
	api := visit(server, "https://"+readableAppHost+"/api/orders", nil)

	if page.Code != http.StatusBadGateway || !strings.Contains(page.Body.String(), "This App isn&#39;t responding") {
		t.Errorf("navigation: got %d %q", page.Code, page.Body.String())
	}
	if api.Code != http.StatusInternalServerError || !strings.Contains(api.Body.String(), "Internal server error") {
		t.Errorf("API call: got %d %q, want the backend's answer passed through", api.Code, api.Body.String())
	}
}

func TestANotRespondingPageKeepsCheckingWhileEnsureFails(t *testing.T) {
	server := appServerWhoseEnsureFails(t)
	check := http.Header{}
	check.Set("Sec-Fetch-Mode", "cors")

	page := visit(server, "https://"+readableAppHost+"/", browserNavigation())
	answer := visit(server, "https://"+readableAppHost+"/", check)

	if !strings.Contains(page.Body.String(), "response.status >= 500") {
		t.Fatalf("the page does not treat every 5xx answer to its check as still refused: %s", page.Body.String())
	}
	if answer.Code < http.StatusInternalServerError {
		t.Errorf("the page's check got %d, which would reload it into the same page", answer.Code)
	}
}
