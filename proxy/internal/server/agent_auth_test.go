package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/config"
)

const testEnvironmentID = "11111111-2222-3333-4444-555555555555"

type ensureCall struct {
	User   string
	Email  string
	Name   string
	Groups string
}

type controlPlane struct {
	allowed  map[string]bool
	upstream string
	calls    []ensureCall
}

func (c *controlPlane) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/ensure") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		c.calls = append(c.calls, ensureCall{
			User:   r.Header.Get("x-forwarded-user"),
			Email:  r.Header.Get("x-forwarded-email"),
			Name:   r.Header.Get("x-forwarded-preferred-username"),
			Groups: r.Header.Get("x-forwarded-groups"),
		})
		if !c.allowed[r.Header.Get("x-forwarded-user")] {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Project not found"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(backend.EnsureResponse{State: "ready", Upstream: c.upstream})
	}
}

func agentRequest(user string, groups string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/proxy/%s/api/session", testEnvironmentID), nil)
	req.Header.Set("x-forwarded-user", user)
	req.Header.Set("x-forwarded-groups", groups)
	req.Header.Set("x-forwarded-email", user+"@example.test")
	req.Header.Set("x-forwarded-preferred-username", user)
	return req
}

func newAgentServer(t *testing.T, plane *controlPlane) *Server {
	t.Helper()
	control := httptest.NewServer(plane.handler(t))
	t.Cleanup(control.Close)

	return New(
		config.Config{
			Mode:                config.ModeAgent,
			ReadyCacheTTL:       time.Minute,
			NonReadyCacheTTL:    time.Minute,
			ControlPlaneTimeout: 5 * time.Second,
		},
		backend.New(control.URL, "token", 5*time.Second),
		nil,
	)
}

func TestCachedAllowDoesNotLeakToAnotherUserWithTheSameGroups(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()

	plane := &controlPlane{allowed: map[string]bool{"alice": true}, upstream: upstream.URL}
	server := newAgentServer(t, plane)
	groups := "opsiforce-acme,role:opsiforce_can_use_public_api"

	first := httptest.NewRecorder()
	server.ServeHTTP(first, agentRequest("alice", groups))
	if first.Code != http.StatusOK {
		t.Fatalf("alice: got %d want 200", first.Code)
	}

	second := httptest.NewRecorder()
	server.ServeHTTP(second, agentRequest("bob", groups))
	if second.Code != http.StatusNotFound {
		t.Fatalf("bob reused alice's cached allow: got %d want 404", second.Code)
	}

	if len(plane.calls) != 2 {
		t.Fatalf("ensure calls: got %d want 2 (one per user)", len(plane.calls))
	}
	if plane.calls[0].User != "alice" || plane.calls[1].User != "bob" {
		t.Errorf("forwarded users: got %q, %q", plane.calls[0].User, plane.calls[1].User)
	}
}

func TestRepeatedRequestsFromOneUserShareTheCachedEnsure(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()

	plane := &controlPlane{allowed: map[string]bool{"alice": true}, upstream: upstream.URL}
	server := newAgentServer(t, plane)

	for range 3 {
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, agentRequest("alice", "opsiforce-acme"))
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d want 200", rec.Code)
		}
	}

	if len(plane.calls) != 1 {
		t.Fatalf("ensure calls: got %d want 1", len(plane.calls))
	}
	call := plane.calls[0]
	if call.Email != "alice@example.test" || call.Name != "alice" || call.Groups != "opsiforce-acme" {
		t.Errorf("identity not forwarded verbatim: %+v", call)
	}
}

func TestAuthSignatureIsUnambiguousAcrossComponentBoundaries(t *testing.T) {
	left := http.Header{}
	left.Set("x-forwarded-user", "ab")
	left.Set("x-forwarded-groups", "c")

	right := http.Header{}
	right.Set("x-forwarded-user", "a")
	right.Set("x-forwarded-groups", "bc")

	if authSignature(left) == authSignature(right) {
		t.Error("ambiguous encoding: (ab, c) and (a, bc) hash alike")
	}
}

func TestMissingIdentityIsDeniedAndNotServedFromAnotherUsersEntry(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()

	plane := &controlPlane{allowed: map[string]bool{"alice": true}, upstream: upstream.URL}
	server := newAgentServer(t, plane)

	allowed := httptest.NewRecorder()
	server.ServeHTTP(allowed, agentRequest("alice", "opsiforce-acme"))
	if allowed.Code != http.StatusOK {
		t.Fatalf("alice: got %d want 200", allowed.Code)
	}

	anonymous := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/proxy/%s/api/session", testEnvironmentID), nil)
	anonymous.Header.Set("x-forwarded-groups", "opsiforce-acme")
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, anonymous)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("anonymous caller: got %d want 404", rec.Code)
	}
	if last := plane.calls[len(plane.calls)-1]; last.User != "" {
		t.Errorf("anonymous request forwarded a user id: %q", last.User)
	}
}

func TestStartingStateCarriesRetryAfter(t *testing.T) {
	plane := &controlPlane{allowed: map[string]bool{"alice": true}}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(backend.EnsureResponse{State: "starting"})
	}))
	defer control.Close()
	_ = plane

	server := New(
		config.Config{Mode: config.ModeAgent, ReadyCacheTTL: time.Minute, NonReadyCacheTTL: time.Minute},
		backend.New(control.URL, "token", 5*time.Second),
		nil,
	)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, agentRequest("alice", "opsiforce-acme"))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Errorf("Retry-After: got %q want %q", got, "5")
	}
}

func TestAPodKeyIsCheckedByTheBackendOnEveryRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()

	switchedOn := true
	ensures := 0
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/ensure") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		ensures++
		if r.Header.Get("authorization") != "Bearer gw-pod" || !switchedOn {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"connect_project is switched off"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(backend.EnsureResponse{State: "ready", Upstream: upstream.URL})
	}))
	defer control.Close()

	server := New(
		config.Config{
			Mode:                config.ModeAgent,
			ReadyCacheTTL:       time.Minute,
			NonReadyCacheTTL:    time.Minute,
			ControlPlaneTimeout: 5 * time.Second,
		},
		backend.New(control.URL, "token", 5*time.Second),
		nil,
	)
	podRequest := func() int {
		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/proxy/%s/api/session", testEnvironmentID), nil)
		req.Header.Set("authorization", "Bearer gw-pod")
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := podRequest(); code != http.StatusOK {
		t.Fatalf("switch on: got %d want 200", code)
	}
	switchedOn = false
	if code := podRequest(); code != http.StatusForbidden {
		t.Fatalf("switch off: got %d want 403, not a cached allow", code)
	}
	if ensures != 2 {
		t.Errorf("ensure calls: got %d want 2, one per pod request", ensures)
	}
}

func TestReportedFailureRestartCarriesRetryAfter(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/failure") {
			_, _ = w.Write([]byte(`{"restart":true}`))
			return
		}
		_ = json.NewEncoder(w).Encode(backend.EnsureResponse{State: "ready", Upstream: "http://127.0.0.1:1"})
	}))
	defer control.Close()

	server := New(
		config.Config{Mode: config.ModeAgent, ReadyCacheTTL: time.Minute, NonReadyCacheTTL: time.Minute},
		backend.New(control.URL, "token", 5*time.Second),
		nil,
	)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, agentRequest("alice", "opsiforce-acme"))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d want 503", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Errorf("Retry-After: got %q want %q", got, "5")
	}
}
