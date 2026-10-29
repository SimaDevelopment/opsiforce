package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestOnlyOneDesktop(t *testing.T) {
	m := New()
	m.desktop = &display{}
	if _, err := m.Start(context.Background()); err == nil {
		t.Fatal("allowed a second desktop")
	}
}

func TestViewerCapacity(t *testing.T) {
	m := New()
	for range MaxViewers {
		m.viewers <- struct{}{}
	}
	r := httptest.NewRequest("GET", "/sessions/default/connect", nil)
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Upgrade", "websocket")
	w := httptest.NewRecorder()
	m.Handler().ServeHTTP(w, r)
	if w.Code != 429 {
		t.Fatalf("eleventh viewer: %d", w.Code)
	}
}

func TestRejectInvalidLifecycleRequests(t *testing.T) {
	m := New()
	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"DELETE", "/sessions/default", "", 405},
		{"DELETE", "/sessions/missing", "", 405},
		{"POST", "/sessions", `{}`, 405},
		{"GET", "/sessions/missing/connect", "", 400},
	} {
		w := httptest.NewRecorder()
		m.Handler().ServeHTTP(w, httptest.NewRequest(test.method, test.path, strings.NewReader(test.body)))
		if w.Code != test.status {
			t.Errorf("%s %s: %d", test.method, test.path, w.Code)
		}
	}
}

// Run inside the agent image: exercises actual X11 window discovery and RFB,
// without needing a browser, user credentials, or an LLM call.
func TestX11DesktopAndWindowStreaming(t *testing.T) {
	for _, binary := range []string{"Xvfb", "wmctrl", "openbox", "x11vnc", "xterm", "xdpyinfo", "xclip"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skip("requires agent image: " + binary)
		}
	}
	m := New()
	defer m.Close()
	ctx := context.Background()
	s, err := m.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if list := m.List(ctx); len(list) != 1 || list[0].Visible {
		t.Fatalf("idle desktop should be hidden: %+v", list)
	}
	workspaces := exec.Command("wmctrl", "-d")
	workspaces.Env = displayEnv(s.Display)
	out, err := workspaces.Output()
	if err != nil || len(strings.Split(strings.TrimSpace(string(out)), "\n")) != 1 {
		t.Fatalf("expected one virtual workspace: %s (%v)", out, err)
	}

	app, err := startProcess(displayEnv(s.Display), "xterm", "-title", "Desktop integration test", "-geometry", "60x15")
	if err != nil {
		t.Fatal(err)
	}
	defer app.stop()
	var found []Window
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		found, _ = windows(ctx, s.Display)
		if len(found) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(found) != 1 {
		t.Fatalf("windows: %+v", found)
	}
	if err := m.Present(ctx, s.ID, found[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := m.Present(ctx, s.ID, "0xdeadbeef"); err == nil {
		t.Fatal("accepted foreign window")
	}
	server := httptest.NewServer(m.Handler())
	defer server.Close()
	desktopWidth, desktopHeight := readFramebuffer(t, server.URL+"/sessions/default/connect")
	windowWidth, windowHeight := readFramebuffer(t, server.URL+"/sessions/default/connect?window="+found[0].ID)
	if desktopWidth != 1440 || desktopHeight != 900 {
		t.Fatalf("desktop %dx%d", desktopWidth, desktopHeight)
	}
	if windowWidth >= desktopWidth || windowHeight >= desktopHeight {
		t.Fatalf("window not cropped: %dx%d", windowWidth, windowHeight)
	}
	testUnicodeClipboard(t)

	// Both views share one X server; the cap applies to live viewers.
	for deadline := time.Now().Add(5 * time.Second); len(m.viewers) > 0 && time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
	}
	address := "ws" + strings.TrimPrefix(server.URL, "http") + "/sessions/default/connect"
	for range MaxViewers {
		ws, _, err := websocket.DefaultDialer.Dial(address, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer ws.Close()
	}
	ws, response, err := websocket.DefaultDialer.Dial(address, nil)
	if ws != nil {
		ws.Close()
	}
	if err == nil || response == nil || response.StatusCode != 429 {
		t.Fatalf("eleventh viewer should be rejected: response=%v err=%v", response, err)
	}
	response.Body.Close()
	if list := m.List(ctx); len(list) != 1 || list[0].Display != ":99" {
		t.Fatalf("viewers created additional desktops: %+v", list)
	}

	t.Logf("desktop=%dx%d window=%dx%d", desktopWidth, desktopHeight, windowWidth, windowHeight)
}

func readFramebuffer(t *testing.T, address string) (uint16, uint16) {
	_, _, width, height, close := connectFramebuffer(t, address)
	defer close()
	return width, height
}

func connectFramebuffer(t *testing.T, address string) (*websocket.Conn, io.Reader, uint16, uint16, func()) {
	t.Helper()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(address, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = ws.SetReadDeadline(time.Now().Add(10 * time.Second))
	reader, writer := io.Pipe()
	close := func() { ws.Close(); reader.Close() }
	t.Cleanup(close)
	go func() {
		defer writer.Close()
		for {
			_, message, err := ws.NextReader()
			if err != nil {
				return
			}
			if _, err := io.Copy(writer, message); err != nil {
				return
			}
		}
	}()
	read := func(n int) []byte {
		b := make([]byte, n)
		if _, err := io.ReadFull(reader, b); err != nil {
			t.Fatal(err)
		}
		return b
	}
	send := func(b []byte) {
		if err := ws.WriteMessage(websocket.BinaryMessage, b); err != nil {
			t.Fatal(err)
		}
	}
	if version := string(read(12)); version != "RFB 003.008\n" {
		t.Fatalf("RFB version %q", version)
	}
	send([]byte("RFB 003.008\n"))
	count := int(read(1)[0])
	security := read(count)
	if count != 1 || security[0] != 1 {
		t.Fatalf("unexpected security types %v", security)
	}
	send([]byte{1})
	if result := binary.BigEndian.Uint32(read(4)); result != 0 {
		t.Fatalf("security result %d", result)
	}
	send([]byte{1})
	header := read(24)
	read(int(binary.BigEndian.Uint32(header[20:24])))
	return ws, reader, binary.BigEndian.Uint16(header[0:2]), binary.BigEndian.Uint16(header[2:4]), close
}

func testUnicodeClipboard(t *testing.T) {
	t.Helper()
	handler := ClipboardHandler()
	const text = "Unicode clipboard\nשלום café 😀"
	payload, _ := json.Marshal(map[string]string{"text": text})
	request := httptest.NewRequest("PUT", "/_desktop/clipboard", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("clipboard PUT: %d %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest("PUT", "/_desktop/clipboard", strings.NewReader(`{"text":"`+strings.Repeat("a", maxClipboardBytes+1)+`"}`))
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 413 {
		t.Fatalf("oversize clipboard: %d", response.Code)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/_desktop/clipboard", nil))
	var body struct {
		Text string `json:"text"`
	}
	if response.Code != 200 {
		t.Fatalf("clipboard GET: %d %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Text != text {
		t.Fatalf("Unicode clipboard round-trip failed: %v", err)
	}
	const copied = "Copied from native app: שלום 😀"
	cmd := exec.Command("xclip", "-selection", "clipboard", "-in")
	cmd.Env = displayEnv(":99")
	cmd.Stdin = strings.NewReader(copied)
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/_desktop/clipboard", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Text != copied {
		t.Fatalf("native app clipboard read failed: %v", err)
	}
	// A native app can own a clipboard larger than our API allows. Bound reads
	// too: embedding bytes.Buffer would let io.Copy bypass a Write-only limit.
	cmd = exec.Command("xclip", "-selection", "clipboard", "-in")
	cmd.Env = displayEnv(":99")
	cmd.Stdin = strings.NewReader(strings.Repeat("x", maxClipboardBytes+1))
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/_desktop/clipboard", nil))
	if response.Code != 413 {
		t.Fatalf("oversize native clipboard read: %d", response.Code)
	}
	t.Log("UTF-8 clipboard in both directions and size limit passed")
}
