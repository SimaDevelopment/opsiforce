package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const platformOrigin = "https://opsiforce.test"

const appPage = `<!doctype html><html lang="en"><head><title>Orders</title></head><body><a href="/orders?status=open">Open</a></body></html>`

func startPageUpstream(t *testing.T, page string) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	}))
	t.Cleanup(server.Close)
	return server.URL
}

func previewAnswer(upstream string) *appControlPlane {
	answer := serveAnswer(upstream)
	answer.PreviewFrameOrigin = platformOrigin
	return &appControlPlane{answer: answer}
}

func loadedIntoTheFrame() http.Header {
	return http.Header{"Sec-Fetch-Dest": {"iframe"}}
}

func TestAPageLoadedIntoThePreviewFrameReportsItsLocationToThePlatformOnly(t *testing.T) {
	server := newAppServer(t, previewAnswer(startPageUpstream(t, appPage)))

	rec := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", loadedIntoTheFrame())

	body := rec.Body.String()
	if !strings.HasPrefix(body, `<!doctype html><html lang="en"><head><script>`) {
		t.Fatalf("the reporter is not the first thing in <head>: %.120q", body)
	}
	if !strings.Contains(body, `var platformOrigin = "`+platformOrigin+`";`) {
		t.Error("the reporter does not post to the platform origin alone")
	}
	if !strings.HasSuffix(body, `</script><title>Orders</title></head><body><a href="/orders?status=open">Open</a></body></html>`) {
		t.Errorf("the App's page changed around the reporter: %q", body)
	}
	if got := rec.Header().Get("Content-Length"); got != "" {
		t.Errorf("Content-Length %q survived a body that grew", got)
	}
}

func TestAPageWithoutAHeadStillGetsTheReporterAfterItsDoctype(t *testing.T) {
	server := newAppServer(t, previewAnswer(startPageUpstream(t, "<!DOCTYPE html><p>bare</p>")))

	body := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", loadedIntoTheFrame()).Body.String()

	if !strings.HasPrefix(body, "<!DOCTYPE html><script>") || !strings.HasSuffix(body, "</script><p>bare</p>") {
		t.Errorf("got %.120q", body)
	}
}

func TestHTMLTheAppFetchesForItselfIsNeverTouched(t *testing.T) {
	server := newAppServer(t, previewAnswer(startPageUpstream(t, appPage)))

	rec := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", http.Header{"Sec-Fetch-Dest": {"empty"}})

	if rec.Body.String() != appPage {
		t.Errorf("a fetched fragment changed: %q", rec.Body.String())
	}
}

func TestAnAppHostFramedElsewhereIsNeverTouched(t *testing.T) {
	server := newAppServer(t, &appControlPlane{answer: serveAnswer(startPageUpstream(t, appPage))})

	rec := visit(server, "https://"+readableAppHost+"/", loadedIntoTheFrame())

	if rec.Body.String() != appPage {
		t.Errorf("a page off the preview host changed: %q", rec.Body.String())
	}
}

func TestAFramedPreviewLoadAlwaysGetsAWholePageToReportFrom(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(appPage))
	}))
	t.Cleanup(upstream.Close)
	server := newAppServer(t, previewAnswer(upstream.URL))
	revalidating := loadedIntoTheFrame()
	revalidating.Set("If-None-Match", `W/"cached-before-the-reporter"`)
	revalidating.Set("If-Modified-Since", "Wed, 04 Nov 2026 08:00:00 GMT")

	rec := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", revalidating)

	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "opsiforce-preview:location") {
		t.Errorf("got %d %.80q, want the whole page with the reporter instead of the browser's cached copy", rec.Code, rec.Body.String())
	}
}

func TestAStreamedPageReachesTheFrameBeforeTheAppFinishesIt(t *testing.T) {
	shell := `<!doctype html><html><head><title>Orders</title></head><body>` + strings.Repeat("<p>row</p>", 1000)
	finish := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(shell))
		w.(http.Flusher).Flush()
		<-finish
		_, _ = w.Write([]byte(`<p>deferred</p></body></html>`))
	}))
	t.Cleanup(upstream.Close)
	proxy := httptest.NewServer(newAppServer(t, previewAnswer(upstream.URL)))
	t.Cleanup(proxy.Close)
	t.Cleanup(func() { close(finish) })

	req, _ := http.NewRequest(http.MethodGet, proxy.URL+"/", nil)
	req.Host = testEnvironmentID + ".preview.apps.test"
	req.Header.Set("Sec-Fetch-Dest", "iframe")
	arrived := make(chan string, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			arrived <- err.Error()
			return
		}
		defer resp.Body.Close()
		head := make([]byte, 4<<10)
		n, _ := io.ReadFull(resp.Body, head)
		arrived <- string(head[:n])
	}()

	select {
	case head := <-arrived:
		if !strings.HasPrefix(head, `<!doctype html><html><head><script>`) {
			t.Errorf("the shell arrived without the reporter first in <head>: %.80q", head)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing reached the frame while the App was still rendering")
	}
}

func TestAnAppsOwnErrorPageInTheFrameReportsItsLocationAndKeepsItsStatus(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`<!doctype html><html><head><title>Not found</title></head><body>No such order</body></html>`))
	}))
	t.Cleanup(upstream.Close)
	server := newAppServer(t, previewAnswer(upstream.URL))

	rec := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", loadedIntoTheFrame())

	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want the App's 404", rec.Code)
	}
	if !strings.HasPrefix(rec.Body.String(), `<!doctype html><html><head><script>`) {
		t.Errorf("the App's 404 page has no reporter: %.80q", rec.Body.String())
	}
}

func TestOnlyAPostedPageAsksToBeReloadedWithoutResubmitting(t *testing.T) {
	server := newAppServer(t, previewAnswer(startPageUpstream(t, appPage)))
	posted := httptest.NewRequest(http.MethodPost, "https://"+testEnvironmentID+".preview.apps.test/", strings.NewReader("status=open"))
	posted.Header.Set("Sec-Fetch-Dest", "iframe")
	postedPage := httptest.NewRecorder()
	server.ServeHTTP(postedPage, posted)

	linkedPage := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", loadedIntoTheFrame())

	if !strings.Contains(postedPage.Body.String(), "var postedDocument = true;") {
		t.Error("a page a form posted would be reloaded by resubmitting the form")
	}
	if !strings.Contains(linkedPage.Body.String(), "var postedDocument = false;") {
		t.Error("a linked page lost its ordinary reload")
	}
}

func TestTheReporterLandsInThePagesOpeningAndNeverInsideItsScriptsOrComments(t *testing.T) {
	cases := []struct {
		name, page, before string
	}{
		{"after the head tag", `<!doctype html><html lang="en"><head data-x='a>b'><title>`, `<!doctype html><html lang="en"><head data-x='a>b'>`},
		{"before a headless page's first script", `<script>const template = "<head>";</script>`, ``},
		{"past a commented-out head", "<!doctype html>\n<!-- <head> -->\n<body>", "<!doctype html>\n<!-- <head> -->\n"},
		{"before a header element", `<html><header>`, `<html>`},
		{"after a byte order mark", "\uFEFF<title>", "\uFEFF"},
	}
	for _, c := range cases {
		at, decided := reporterInsertionPoint([]byte(c.page), false)
		if !decided || c.page[:at] != c.before {
			t.Errorf("%s: inserted after %q (decided %v), want after %q", c.name, c.page[:at], decided, c.before)
		}
	}
}

func TestAStreamWaitsWhileItsOpeningIsStillArriving(t *testing.T) {
	for _, partial := range []string{"", "  <", "<!doc", "<!doctype html><htm", "<!doctype html><html>", "<!-- <head> ", "<html><head data-x='a>"} {
		if _, decided := reporterInsertionPoint([]byte(partial), false); decided {
			t.Errorf("decided on %q before the opening finished arriving", partial)
		}
		if _, decided := reporterInsertionPoint([]byte(partial), true); !decided {
			t.Errorf("a whole page %q left undecided", partial)
		}
	}
}

func TestACacheablePreviewPageIsKeptApartPerFrameDestination(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Cache-Control", "max-age=3600")
		w.Header().Set("Vary", "Accept-Encoding")
		_, _ = w.Write([]byte(appPage))
	}))
	t.Cleanup(upstream.Close)
	server := newAppServer(t, previewAnswer(upstream.URL))

	for _, destination := range []string{"iframe", "empty"} {
		rec := visit(server, "https://"+testEnvironmentID+".preview.apps.test/", http.Header{"Sec-Fetch-Dest": {destination}})

		if got := strings.Join(rec.Header().Values("Vary"), ", "); got != "Accept-Encoding, Sec-Fetch-Dest" {
			t.Errorf("%s: Vary %q, want the App's own plus Sec-Fetch-Dest", destination, got)
		}
	}
}
