package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func (m *Manager) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /sessions", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, m.List(r.Context()))
	})
	mux.HandleFunc("PATCH /sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Window string `json:"window"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := m.Present(r.Context(), r.PathValue("id"), body.Window); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, os.ErrNotExist) {
				status = http.StatusNotFound
			}
			http.Error(w, err.Error(), status)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /sessions/{id}/connect", m.connect)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}

func readJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "expected application/json", http.StatusUnsupportedMediaType)
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (m *Manager) connect(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		http.Error(w, "WebSocket required", http.StatusBadRequest)
		return
	}
	select {
	case m.viewers <- struct{}{}:
		defer func() { <-m.viewers }()
	default:
		http.Error(w, "maximum of 10 connected viewers reached", http.StatusTooManyRequests)
		return
	}
	m.mu.Lock()
	d := m.desktop
	m.mu.Unlock()
	if d == nil || d.ID != r.PathValue("id") {
		http.NotFound(w, r)
		return
	}
	window := r.URL.Query().Get("window")
	if err := checkWindow(r.Context(), d.Display, window); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Reverse-connect to a listener we already own. No VNC port is exposed,
	// reserved per session, or available for an unrelated process to claim.
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		http.Error(w, "cannot start viewer", http.StatusServiceUnavailable)
		return
	}
	defer listener.Close()
	args := []string{"-norc", "-display", d.Display, "-rfbport", "0", "-connect_or_exit", listener.Addr().String(), "-nopw", "-once", "-shared", "-noremote", "-nocmds", "-nosel", "-quiet"}
	if window != "" {
		args = append(args, "-id", window)
	}
	if r.URL.Query().Get("control") != "1" {
		args = append(args, "-viewonly")
	}
	proc, err := startProcess(displayEnv(d.Display), "x11vnc", args...)
	if err != nil {
		http.Error(w, "VNC is unavailable", http.StatusServiceUnavailable)
		return
	}
	defer proc.stop()
	_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(8 * time.Second))
	tcp, err := listener.Accept()
	if err != nil {
		http.Error(w, "VNC connection failed", http.StatusServiceUnavailable)
		return
	}
	defer tcp.Close()
	_ = listener.Close()

	// The only HTTP entry is the authenticated agent proxy. It checks the
	// browser Origin before rewriting Host to the pod-local destination.
	upgrader := websocket.Upgrader{Subprotocols: []string{"binary"}, CheckOrigin: func(*http.Request) bool { return true }}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	ws.SetReadLimit(1 << 20)
	ctx, cancel := context.WithCancel(d.ctx)
	defer cancel()
	go func() { <-ctx.Done(); _ = tcp.Close(); _ = ws.Close() }()
	go func() {
		defer cancel()
		buf := make([]byte, 32*1024)
		for {
			n, err := tcp.Read(buf)
			if n > 0 {
				_ = ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if ws.WriteMessage(websocket.BinaryMessage, buf[:n]) != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		kind, reader, err := ws.NextReader()
		if err != nil {
			return
		}
		if kind != websocket.BinaryMessage {
			return
		}
		_ = tcp.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := io.Copy(tcp, reader); err != nil {
			return
		}
	}
}
