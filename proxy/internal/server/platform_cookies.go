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
		switch {
		case pair == "":
		case isPlatformCookie(pair):
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

func dropPlatformSetCookies(headers http.Header) {
	values := headers.Values("Set-Cookie")
	kept := make([]string, 0, len(values))
	for _, value := range values {
		if !isPlatformCookie(value) {
			kept = append(kept, value)
		}
	}
	if len(kept) == len(values) {
		return
	}
	headers.Del("Set-Cookie")
	for _, value := range kept {
		headers.Add("Set-Cookie", value)
	}
}

func isPlatformCookie(pairOrSetCookie string) bool {
	name, _, _ := strings.Cut(pairOrSetCookie, "=")
	return strings.HasPrefix(strings.TrimSpace(name), platformCookiePrefix)
}
