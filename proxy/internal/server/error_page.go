package server

import (
	"bytes"
	_ "embed"
	"html/template"
	"net/http"
	"strings"

	"opsiforce/proxy/internal/config"
)

const (
	unresponsiveCheckAfterSeconds = 10
	pageCheckForSeconds           = 300
)

//go:embed error_page.html
var errorPageSource string

var errorPageTemplate = template.Must(template.New("error_page").Parse(errorPageSource))

type refusal struct {
	status int
	body   []byte
	page   []byte
}

type errorPage struct {
	Icon            string
	Title           string
	Detail          string
	CheckAfter      int
	CheckForSeconds int
}

var (
	restarting = newRefusal(http.StatusServiceUnavailable, restartingBody, errorPage{
		Icon:       "starting",
		Title:      "Starting up",
		Detail:     "This App is waking up.",
		CheckAfter: restartRetryAfterSeconds,
	})
	unresponsive = newRefusal(http.StatusBadGateway, badGatewayBody, errorPage{
		Icon:       "unresponsive",
		Title:      "This App isn't responding",
		Detail:     "It may be restarting or have stopped.",
		CheckAfter: unresponsiveCheckAfterSeconds,
	})
	failedToStart = newRefusal(http.StatusBadGateway, badGatewayBody, errorPage{
		Icon:   "failed",
		Title:  "This App couldn't start",
		Detail: "Ask its owner to take a look.",
	})
	turnedOff = newRefusal(http.StatusLocked, disabledBody, errorPage{
		Icon:   "off",
		Title:  "This App is turned off",
		Detail: "Ask its owner to turn it back on.",
	})
	notFound = newRefusal(http.StatusNotFound, notFoundBody, errorPage{
		Icon:   "missing",
		Title:  "App not found",
		Detail: "There's no App at this address. Check the link and try again.",
	})
)

func newRefusal(status int, body []byte, page errorPage) refusal {
	if page.CheckAfter > 0 {
		page.CheckForSeconds = pageCheckForSeconds
	}
	var buf bytes.Buffer
	if err := errorPageTemplate.Execute(&buf, page); err != nil {
		panic(err)
	}
	return refusal{status: status, body: body, page: buf.Bytes()}
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, refused refusal) {
	if s.servesPage(r) {
		writePage(w, refused)
		return
	}
	writeJSONStatus(w, refused.status, refused.body)
}

func (s *Server) servesPage(r *http.Request) bool {
	return s.cfg.Mode == config.ModeApp && isPageNavigation(r)
}

func writePage(w http.ResponseWriter, refused refusal) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(refused.status)
	_, _ = w.Write(refused.page)
}

func isPageNavigation(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" {
		return mode == "navigate"
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}
