package server

import (
	"net/http"
	"strings"
)

const platformCookiePrefix = "_opsiforce_"

func stripPlatformCookies(headers http.Header) {
	values := headers.Values("Cookie")
	if len(values) == 0 {
		return
	}

	kept := make([]string, 0, len(values))
	for _, value := range values {
		if remaining := withoutPlatformCookies(value); remaining != "" {
			kept = append(kept, remaining)
		}
	}

	if len(kept) == 0 {
		headers.Del("Cookie")
		return
	}
	headers["Cookie"] = kept
}

func withoutPlatformCookies(value string) string {
	removed := false
	kept := make([]string, 0, strings.Count(value, ";")+1)
	for _, pair := range strings.Split(value, ";") {
		pair = strings.TrimSpace(pair)
		name, _, _ := strings.Cut(pair, "=")
		switch {
		case pair == "":
		case strings.HasPrefix(strings.TrimSpace(name), platformCookiePrefix):
			removed = true
		default:
			kept = append(kept, pair)
		}
	}

	if !removed {
		return value
	}
	return strings.Join(kept, "; ")
}
