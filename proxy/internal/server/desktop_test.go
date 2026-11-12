package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDesktopUsesProjectAuthorizationAndPreservesPath(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/_desktop/sessions" && r.URL.Path != "/_desktop/clipboard" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("x-forwarded-user") != "" {
			t.Error("identity leaked into pod")
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer upstream.Close()
	plane := &controlPlane{allowed: map[string]bool{"alice": true}, upstream: upstream.URL}
	s := newAgentServer(t, plane)
	for _, route := range []struct{ method, path string }{
		{"GET", "/_desktop/sessions"}, {"GET", "/_desktop/clipboard"}, {"PUT", "/_desktop/clipboard"},
	} {
		for _, user := range []string{"alice", "bob", ""} {
			r := agentRequest(user, "opsiforce-acme")
			r.Method = route.method
			r.URL.Path = "/api/proxy/" + testEnvironmentID + route.path
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			want := http.StatusNotFound
			if user == "alice" {
				want = http.StatusOK
			}
			if w.Code != want {
				t.Fatalf("%s: %d, want %d", user, w.Code, want)
			}
		}
	}
}

func TestDesktopOrigin(t *testing.T) {
	for _, test := range []struct {
		origin  string
		upgrade bool
		allowed bool
	}{
		{"https://opsiforce.example", true, true},
		{"https://evil.example", true, false},
		{"http://opsiforce.example", true, false},
		{"null", true, false},
		{"", true, false},
		{"", false, true},
		{"https://opsiforce.example.evil.test", false, false},
	} {
		r := httptest.NewRequest("POST", "https://opsiforce.example/api/proxy/test/_desktop/sessions", strings.NewReader(`{}`))
		if test.origin != "" {
			r.Header.Set("Origin", test.origin)
		}
		if test.upgrade {
			r.Header.Set("Upgrade", "websocket")
			r.Header.Set("Connection", "Upgrade")
		}
		if got := desktopOriginAllowed(r); got != test.allowed {
			t.Errorf("%+v: %v", test, got)
		}
	}
}
