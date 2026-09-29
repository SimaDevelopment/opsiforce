package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeMeta(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, metaFileName), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestProbeAppIsLiveForAnyAnswerWithMetaPresent(t *testing.T) {
	dir := t.TempDir()
	writeMeta(t, dir, `{"name":"Fuel Log","description":"Track fuel"}`)

	for _, status := range []int{http.StatusOK, http.StatusNotFound, http.StatusInternalServerError} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
		}))

		state := probeApp(server.Client(), server.URL+"/", dir)
		server.Close()

		if !state.Serving || !state.Live {
			t.Fatalf("status %d: got serving=%v live=%v, want both true", status, state.Serving, state.Live)
		}
		if state.Name == nil || *state.Name != "Fuel Log" {
			t.Fatalf("status %d: name not read from %s", status, metaFileName)
		}
		if state.Description == nil || *state.Description != "Track fuel" {
			t.Fatalf("status %d: description not read from %s", status, metaFileName)
		}
	}
}

func TestProbeAppServesWithoutMeta(t *testing.T) {
	dir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer server.Close()

	state := probeApp(server.Client(), server.URL+"/", dir)

	if !state.Serving {
		t.Fatal("want serving")
	}
	if state.Live {
		t.Fatal("want not live without app.meta.json")
	}
}

func TestProbeAppReportsDownWhenTheProcessExits(t *testing.T) {
	dir := t.TempDir()
	writeMeta(t, dir, `{"name":"Fuel Log","description":"Track fuel"}`)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	client := server.Client()
	url := server.URL + "/"
	server.Close()

	state := probeApp(client, url, dir)

	if state.Serving || state.Live {
		t.Fatalf("got serving=%v live=%v, want both false", state.Serving, state.Live)
	}
}

func TestProbeAppIgnoresMalformedMeta(t *testing.T) {
	dir := t.TempDir()
	writeMeta(t, dir, "not json")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer server.Close()

	state := probeApp(server.Client(), server.URL+"/", dir)

	if !state.Serving || state.Live {
		t.Fatalf("got serving=%v live=%v, want serving without live", state.Serving, state.Live)
	}
}
