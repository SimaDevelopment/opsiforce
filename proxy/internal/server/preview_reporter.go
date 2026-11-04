package server

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

//go:embed preview_reporter.js
var previewReporterSource string

const reporterSearchLimit = 64 << 10

var (
	openingHeadTag = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
	openingHTMLTag = regexp.MustCompile(`(?i)<html(?:\s[^>]*)?>`)
	doctype        = regexp.MustCompile(`(?i)<!doctype[^>]*>`)
)

func loadsIntoAFrame(r *http.Request) bool {
	return r.Header.Get("Sec-Fetch-Dest") == "iframe"
}

func askForAWholePage(headers http.Header) {
	headers.Del("If-None-Match")
	headers.Del("If-Modified-Since")
}

type previewFrame struct {
	platformOrigin string
	posted         bool
}

func previewFrameOf(r *http.Request, platformOrigin string) previewFrame {
	return previewFrame{platformOrigin: platformOrigin, posted: r.Method != http.MethodGet}
}

func withPreviewReporter(page []byte, frame previewFrame) []byte {
	at, _ := reporterInsertionPoint(page)
	return spliced(page, at, reporterScript(frame))
}

func streamWithPreviewReporter(page io.ReadCloser, frame previewFrame) (io.ReadCloser, error) {
	chunk := make([]byte, 4<<10)
	var prefix []byte
	for {
		n, err := page.Read(chunk)
		prefix = append(prefix, chunk[:n]...)
		at, found := reporterInsertionPoint(prefix)
		if found || errors.Is(err, io.EOF) || len(prefix) >= reporterSearchLimit {
			head := spliced(prefix, at, reporterScript(frame))
			return struct {
				io.Reader
				io.Closer
			}{io.MultiReader(bytes.NewReader(head), page), page}, nil
		}
		if err != nil {
			page.Close()
			return nil, err
		}
	}
}

func reporterInsertionPoint(page []byte) (int, bool) {
	for _, tag := range []*regexp.Regexp{openingHeadTag, openingHTMLTag, doctype} {
		if loc := tag.FindIndex(page); loc != nil {
			return loc[1], true
		}
	}
	return 0, false
}

func reporterScript(frame previewFrame) []byte {
	origin, _ := json.Marshal(frame.platformOrigin)
	source := strings.NewReplacer(
		"PLATFORM_ORIGIN", string(origin),
		"POSTED_DOCUMENT", strconv.FormatBool(frame.posted),
	).Replace(previewReporterSource)
	return []byte("<script>" + source + "</script>")
}

func spliced(page []byte, at int, script []byte) []byte {
	return bytes.Join([][]byte{page[:at], script, page[at:]}, nil)
}
