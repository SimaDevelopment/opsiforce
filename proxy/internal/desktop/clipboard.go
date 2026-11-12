package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

const maxClipboardBytes = 1 << 20

var errClipboardTooLarge = errors.New("clipboard text exceeds 1 MiB")

type clipboardBuffer struct {
	buffer   bytes.Buffer
	overflow bool
}

func (b *clipboardBuffer) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > maxClipboardBytes {
		b.overflow = true
		return 0, errClipboardTooLarge
	}
	return b.buffer.Write(p)
}

// ClipboardHandler transports UTF-8 text without legacy RFB's Latin-1 limit.
// It is served only through agent-control and the authenticated desktop route.
func ClipboardHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "xclip", "-selection", "clipboard", "-out")
		cmd.Env = displayEnv(":99")
		var out clipboardBuffer
		cmd.Stdout = &out
		if err := cmd.Run(); err != nil {
			status := http.StatusServiceUnavailable
			if out.overflow {
				status = http.StatusRequestEntityTooLarge
			}
			http.Error(w, "desktop clipboard unavailable or too large", status)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": out.buffer.String()})
	})
	mux.HandleFunc("PUT /", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "expected application/json", http.StatusUnsupportedMediaType)
			return
		}
		var body struct {
			Text string `json:"text"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 6*maxClipboardBytes+32))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil {
			http.Error(w, "invalid clipboard request", http.StatusBadRequest)
			return
		}
		if len(body.Text) > maxClipboardBytes {
			http.Error(w, errClipboardTooLarge.Error(), http.StatusRequestEntityTooLarge)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		// xclip forks its selection owner after accepting the text. The owner exits
		// when another app replaces the clipboard, or when the X server shuts down.
		cmd := exec.CommandContext(ctx, "xclip", "-selection", "clipboard", "-in")
		cmd.Env = displayEnv(":99")
		cmd.Stdin = strings.NewReader(body.Text)
		if err := cmd.Run(); err != nil {
			http.Error(w, "cannot set desktop clipboard", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}
