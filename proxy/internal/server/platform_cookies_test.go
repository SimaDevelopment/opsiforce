package server

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestStripPlatformCookies(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{
			name: "every deployment's session cookie removed",
			in:   []string{"_opsiforce_dev=d; _opsiforce_prod=p; _opsiforce_cabka=c; _opsiforce_local=l; keep=1"},
			want: []string{"keep=1"},
		},
		{
			name: "platform cookie removed, App cookies kept byte for byte",
			in:   []string{`theme=dark; _opsiforce_prod=c2Vzc2lvbg==|1700000000|sig; app_session="a b"; empty=`},
			want: []string{`theme=dark; app_session="a b"; empty=`},
		},
		{
			name: "split session cookies removed",
			in:   []string{"_opsiforce_prod_0=part0; cart=3; _opsiforce_prod_1=part1"},
			want: []string{"cart=3"},
		},
		{
			name: "csrf cookies removed",
			in:   []string{"_opsiforce_prod_csrf=a; _opsiforce_prod_Ab3x9_csrf=b; csrf=mine"},
			want: []string{"csrf=mine"},
		},
		{
			name: "only platform cookies drops the header",
			in:   []string{"_opsiforce_prod=s; _opsiforce_prod_0=p", "_opsiforce_prod_csrf=c"},
			want: nil,
		},
		{
			name: "a value without platform cookies is untouched",
			in:   []string{"a=1;b=2 ;  c=3"},
			want: []string{"a=1;b=2 ;  c=3"},
		},
		{
			name: "App Auth's cookies and near-miss names are kept",
			in:   []string{"TraefikOidcAuth.Session=s; TraefikOidcAuth.CodeVerifier=v; _opsiforce=x; opsiforce_prod=y; X_opsiforce_prod=z; _OPSIFORCE_PROD=w"},
			want: []string{"TraefikOidcAuth.Session=s; TraefikOidcAuth.CodeVerifier=v; _opsiforce=x; opsiforce_prod=y; X_opsiforce_prod=z; _OPSIFORCE_PROD=w"},
		},
		{
			name: "padded names are still matched",
			in:   []string{"keep=1; _opsiforce_prod =s;;"},
			want: []string{"keep=1"},
		},
		{
			name: "each Cookie line is filtered on its own",
			in:   []string{"_opsiforce_prod=s", "keep=1; _opsiforce_prod_0=p"},
			want: []string{"keep=1"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			headers := http.Header{"Cookie": tc.in}
			stripPlatformCookies(headers)
			got, present := headers["Cookie"]
			if tc.want == nil {
				if present {
					t.Fatalf("Cookie header survived: %q", got)
				}
				return
			}
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Fatalf("Cookie = %q, want %q", got, tc.want)
			}
		})
	}
}

type cookieRecorder struct {
	mu      sync.Mutex
	cookies [][]string
}

func (c *cookieRecorder) record(r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	values, present := r.Header["Cookie"]
	if !present {
		values = nil
	}
	c.cookies = append(c.cookies, values)
}

func (c *cookieRecorder) last(t *testing.T) []string {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cookies) == 0 {
		t.Fatal("the App received no request")
	}
	return c.cookies[len(c.cookies)-1]
}

func startProxiedApp(t *testing.T, app http.Handler) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(app)
	t.Cleanup(upstream.Close)

	proxy := httptest.NewServer(newAppServer(t, &appControlPlane{answer: serveAnswer(upstream.URL)}))
	t.Cleanup(proxy.Close)
	return proxy
}

func TestTheAppNeverReceivesThePlatformSessionCookie(t *testing.T) {
	recorder := &cookieRecorder{}
	proxy := startProxiedApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder.record(r)
		w.WriteHeader(http.StatusOK)
	}))

	for _, tc := range []struct {
		cookie string
		want   []string
	}{
		{cookie: "theme=dark; _opsiforce_prod=session; _opsiforce_prod_abc_csrf=c", want: []string{"theme=dark"}},
		{cookie: "_opsiforce_cabka_0=p0; _opsiforce_cabka_1=p1", want: nil},
		{cookie: "TraefikOidcAuth.Session=app; _opsiforce_dev=session", want: []string{"TraefikOidcAuth.Session=app"}},
		{cookie: "theme=dark;cart=3", want: []string{"theme=dark;cart=3"}},
	} {
		req, _ := http.NewRequest(http.MethodGet, proxy.URL+"/page", nil)
		req.Host = readableAppHost
		req.Header.Set("Cookie", tc.cookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if got := recorder.last(t); strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
			t.Fatalf("App got Cookie %q for %q, want %q", got, tc.cookie, tc.want)
		}
	}
}

func TestAWebSocketUpgradeNeverCarriesThePlatformSessionCookie(t *testing.T) {
	recorder := &cookieRecorder{}
	proxy := startProxiedApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder.record(r)
		conn, buffered, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		defer conn.Close()
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffered.Flush()
	}))

	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_, _ = fmt.Fprintf(conn, "GET /socket HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"+
		"Cookie: _opsiforce_prod=session; ws_token=abc; _opsiforce_prod_0=p0\r\n\r\n", readableAppHost)

	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read upgrade answer: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	if got := recorder.last(t); strings.Join(got, "\n") != "ws_token=abc" {
		t.Fatalf("App got Cookie %q on the upgrade, want only ws_token", got)
	}
}

func TestAppsCannotSetPlatformCookies(t *testing.T) {
	response := func() http.Header {
		h := http.Header{}
		h.Add("Set-Cookie", "theme=dark; Path=/")
		h.Add("Set-Cookie", "_opsiforce_sp_7d1c.Session=forged; Domain=.apps.example; Path=/")
		return h
	}
	streamed := response()
	sanitizeReverseProxyHeaders(streamed, false)
	for name, headers := range map[string]http.Header{"buffered": filterResponseHeaders(response(), false), "streamed": streamed} {
		if got := headers.Values("Set-Cookie"); len(got) != 1 || got[0] != "theme=dark; Path=/" {
			t.Fatalf("%s: unexpected Set-Cookie %q", name, got)
		}
	}
}
