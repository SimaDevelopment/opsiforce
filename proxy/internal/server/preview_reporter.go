package server

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

//go:embed preview_reporter.js
var previewReporterSource string

var (
	openingHeadTag = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
	openingHTMLTag = regexp.MustCompile(`(?i)<html(?:\s[^>]*)?>`)
	doctype        = regexp.MustCompile(`(?i)<!doctype[^>]*>`)
)

func loadsIntoAFrame(r *http.Request) bool {
	return r.Method == http.MethodGet && r.Header.Get("Sec-Fetch-Dest") == "iframe"
}

func askForAWholePage(headers http.Header) {
	headers.Del("If-None-Match")
	headers.Del("If-Modified-Since")
}

func withPreviewReporter(page []byte, platformOrigin string) []byte {
	origin, _ := json.Marshal(platformOrigin)
	script := []byte("<script>" + strings.Replace(previewReporterSource, "PLATFORM_ORIGIN", string(origin), 1) + "</script>")

	for _, tag := range []*regexp.Regexp{openingHeadTag, openingHTMLTag, doctype} {
		if loc := tag.FindIndex(page); loc != nil {
			return bytes.Join([][]byte{page[:loc[1]], script, page[loc[1]:]}, nil)
		}
	}
	return bytes.Join([][]byte{script, page}, nil)
}
