package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestAPodIsAskedForAsLocalhostOnItsPort(t *testing.T) {
	var presented string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		presented = r.Host
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()

	plane := &controlPlane{allowed: map[string]bool{"alice": true}, upstream: upstream.URL}
	server := newAgentServer(t, plane)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, agentRequest("alice", "opsiforce-example-org"))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200", rec.Code)
	}

	address, _ := url.Parse(upstream.URL)
	if want := "localhost:" + address.Port(); presented != want {
		t.Errorf("Host: got %q want %q", presented, want)
	}
}
