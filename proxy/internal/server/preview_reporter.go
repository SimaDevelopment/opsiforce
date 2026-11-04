package server

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

//go:embed preview_reporter.js
var previewReporterSource string

const reporterSearchLimit = 64 << 10

var prologueOpenings = []string{"<!--", "<!doctype", "<html", "<head"}

func loadsIntoAFrame(r *http.Request) bool {
	return r.Header.Get("Sec-Fetch-Dest") == "iframe"
}

func varyByFrameDestination(headers http.Header) {
	for _, value := range headers.Values("Vary") {
		for _, field := range strings.Split(value, ",") {
			name := strings.TrimSpace(field)
			if name == "*" || strings.EqualFold(name, "Sec-Fetch-Dest") {
				return
			}
		}
	}
	headers.Add("Vary", "Sec-Fetch-Dest")
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
	at, _ := reporterInsertionPoint(page, true)
	return spliced(page, at, reporterScript(frame))
}

func streamWithPreviewReporter(page io.ReadCloser, frame previewFrame) (io.ReadCloser, error) {
	chunk := make([]byte, 4<<10)
	var prefix []byte
	for {
		n, err := page.Read(chunk)
		prefix = append(prefix, chunk[:n]...)
		final := errors.Is(err, io.EOF) || len(prefix) >= reporterSearchLimit
		if at, decided := reporterInsertionPoint(prefix, final); decided {
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

func reporterInsertionPoint(page []byte, whole bool) (int, bool) {
	at := 0
	if bytes.HasPrefix(page, []byte("\uFEFF")) {
		at = len("\uFEFF")
	}
	for {
		rest := bytes.TrimLeft(page[at:], " \t\r\n\f")
		at = len(page) - len(rest)
		if len(rest) == 0 || (!whole && couldStillOpenThePrologue(rest)) {
			return at, whole
		}
		var end int
		switch {
		case hasPrefixFold(rest, "<!--"):
			end = bytes.Index(rest, []byte("-->"))
			if end >= 0 {
				end += len("-->")
			}
		case hasPrefixFold(rest, "<!doctype"), opensElement(rest, "html"):
			end = tagEnd(rest)
		case opensElement(rest, "head"):
			if end = tagEnd(rest); end >= 0 {
				return at + end, true
			}
		default:
			return at, true
		}
		if end < 0 {
			return at, whole
		}
		at += end
	}
}

func couldStillOpenThePrologue(rest []byte) bool {
	for _, opening := range prologueOpenings {
		if len(rest) <= len(opening) && hasPrefixFold([]byte(opening), string(rest)) {
			return true
		}
	}
	return false
}

func hasPrefixFold(b []byte, prefix string) bool {
	return len(b) >= len(prefix) && strings.EqualFold(string(b[:len(prefix)]), prefix)
}

func opensElement(b []byte, name string) bool {
	return hasPrefixFold(b, "<"+name) && len(b) > len(name)+1 && strings.IndexByte(" \t\r\n\f/>", b[len(name)+1]) >= 0
}

func tagEnd(tag []byte) int {
	var quote byte
	for i, c := range tag {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return i + 1
		}
	}
	return -1
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
