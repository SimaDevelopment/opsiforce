package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"opsiforce/proxy/internal/backend"
	"opsiforce/proxy/internal/requestlog"
)

const loggedDirectory = "projects/env"

type loggedRequest struct {
	url            string
	requestHeaders map[string]string
	requestBody    string
	responseBody   string
}

// serveLogged sends one request through an app-mode proxy that writes a real
// request log, then closes the log so every entry is on disk.
func serveLogged(t *testing.T, logging *backend.LoggingConfig, req *http.Request) []loggedRequest {
	t.Helper()
	_, upstreamURL := startUpstream(t)
	return serveLoggedTo(t, upstreamURL, logging, req)
}

func serveLoggedTo(t *testing.T, upstreamURL string, logging *backend.LoggingConfig, req *http.Request) []loggedRequest {
	t.Helper()
	answer := serveAnswer(upstreamURL)
	answer.Directory = loggedDirectory
	answer.Logging = logging
	root := t.TempDir()
	logger := requestlog.New(root, 8)
	server := newLoggedAppServer(t, &appControlPlane{answer: answer}, logger)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d want 200", rec.Code)
	}
	if err := logger.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	return readRequestLog(t, filepath.Join(root, loggedDirectory, "data", "database.db"))
}

func readRequestLog(t *testing.T, path string) []loggedRequest {
	t.Helper()
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT url, COALESCE(request_headers, ''), COALESCE(request_body, ''), COALESCE(response_body, '')
		FROM app_requests ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var logged []loggedRequest
	for rows.Next() {
		var row loggedRequest
		var headers string
		if err := rows.Scan(&row.url, &headers, &row.requestBody, &row.responseBody); err != nil {
			t.Fatal(err)
		}
		if headers != "" {
			if err := json.Unmarshal([]byte(headers), &row.requestHeaders); err != nil {
				t.Fatal(err)
			}
		}
		logged = append(logged, row)
	}
	return logged
}

func forwardedPost(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "https://"+readableAppHost+"/api/files?folder=root", strings.NewReader(body))
	for name, values := range forwardingFixture(testEnvironmentID) {
		req.Header[name] = values
	}
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("X-Warehouse-Region", "eu-north")
	return req
}

func TestAForwardedRequestIsLoggedAtTheProjectsLevelWithTheTokenRedacted(t *testing.T) {
	logged := serveLogged(t, &backend.LoggingConfig{Mode: logModeFull, BodyLimit: 1024}, forwardedPost("the visitor's own files"))

	if len(logged) != 1 {
		t.Fatalf("logged %d requests, want the forwarded one", len(logged))
	}
	row := logged[0]
	if row.url != "/api/files?folder=root" {
		t.Errorf("url: got %q", row.url)
	}
	if row.requestBody != "the visitor's own files" || row.responseBody != "app says hi" {
		t.Errorf("a forwarded request at Full lost its bodies: request %q, response %q", row.requestBody, row.responseBody)
	}
	for name, want := range map[string]string{
		"X-Warehouse-Region":  "eu-north",
		forwardedTokenHeader:  "[redacted]",
		forwardedUserIDHeader: "user",
		objectIDHeader:        "object",
		directoryIDHeader:     "tenant",
	} {
		if got := row.requestHeaders[name]; got != want {
			t.Errorf("logged %s: got %q want %q", name, got, want)
		}
	}
	if _, present := row.requestHeaders[forwardingProofHeader]; present {
		t.Error("the forwarding proof was logged")
	}
}

func TestAForwardedRequestFollowsAnOffLoggingLevel(t *testing.T) {
	logged := serveLogged(t, &backend.LoggingConfig{Mode: logModeOff}, forwardedPost("x"))

	if len(logged) != 0 {
		t.Fatalf("logged %d requests with logging off", len(logged))
	}
}

func TestAnUnprovenForwardedTokenNeverReachesTheLog(t *testing.T) {
	req := forwardedPost("plain body")
	req.Header.Del(forwardingProofHeader)
	logged := serveLogged(t, &backend.LoggingConfig{Mode: logModeFull, BodyLimit: 1024}, req)

	if len(logged) != 1 {
		t.Fatalf("logged %d requests, want the unproven one", len(logged))
	}
	for name := range logged[0].requestHeaders {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
			t.Errorf("an unproven reserved header %s survived into the log", name)
		}
	}
}

func TestAForwardedChunkedUploadStreamsToTheAppAndLogsOnlyItsPrefix(t *testing.T) {
	firstChunkArrived := make(chan struct{})
	var received bytes.Buffer
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		head := make([]byte, 4)
		if _, err := io.ReadFull(r.Body, head); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		received.Write(head)
		close(firstChunkArrived)
		rest, _ := io.ReadAll(r.Body)
		received.Write(rest)
		_, _ = w.Write([]byte("stored"))
	}))
	t.Cleanup(app.Close)

	upload, uploader := io.Pipe()
	go func() {
		_, _ = uploader.Write([]byte("head"))
		select {
		case <-firstChunkArrived:
		case <-time.After(5 * time.Second):
			uploader.CloseWithError(errors.New("the App never saw the first chunk before the upload ended"))
			return
		}
		_, _ = uploader.Write(bytes.Repeat([]byte("x"), 4096))
		_ = uploader.Close()
	}()
	req := forwardedPost("")
	req.Body = upload
	req.ContentLength = -1
	req.Header.Del("Content-Length")

	logged := serveLoggedTo(t, app.URL, &backend.LoggingConfig{Mode: logModeFull, BodyLimit: 1024}, req)

	if want := "head" + strings.Repeat("x", 4096); received.String() != want {
		t.Fatalf("the App received %d bytes, want the whole %d-byte upload", received.Len(), len(want))
	}
	if len(logged) != 1 {
		t.Fatalf("logged %d requests, want the upload", len(logged))
	}
	if want := "head" + strings.Repeat("x", 1020); logged[0].requestBody != want {
		t.Errorf("logged a %d-byte request body, want its first 1024 bytes", len(logged[0].requestBody))
	}
	if logged[0].responseBody != "stored" {
		t.Errorf("logged response body %q, want stored", logged[0].responseBody)
	}
}
