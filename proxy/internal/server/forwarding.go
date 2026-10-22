package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

const reservedHeaderPrefix = "x-opsiforce-"
const forwardingProofHeader = "X-Opsiforce-Forwarding-Proof"
const forwardedTokenHeader = "X-Opsiforce-Access-Token"
const forwardedUserIDHeader = "X-Opsiforce-User-Id"
const objectIDHeader = "X-Opsiforce-Object-Id"
const directoryIDHeader = "X-Opsiforce-Directory-Id"

// The OIDC plugin renders a missing claim as "<no value>".
func hasClaimValue(value string) bool {
	return value != "" && value != "<no value>"
}

func stripReservedHeaders(headers http.Header) {
	for name := range headers {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
			delete(headers, name)
		}
	}
}

// Authenticate the per-environment transport credential injected by OIDC.
// Remove it before the request can reach app code, logs, or another surface.
func acceptForwarding(headers http.Header, environmentID, key string) bool {
	names := []string{forwardingProofHeader, forwardedTokenHeader, forwardedUserIDHeader, objectIDHeader, directoryIDHeader}
	values := make(map[string]string)
	valid := len(key) >= 32
	for _, name := range names {
		count := 0
		for actual, vs := range headers {
			if strings.EqualFold(actual, name) {
				count += len(vs)
				if len(vs) == 1 {
					values[name] = vs[0]
				}
			}
		}
		if count != 1 {
			valid = false
		}
	}
	stripReservedHeaders(headers)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("app-auth-forwarding:" + environmentID))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !valid || !hmac.Equal([]byte(values[forwardingProofHeader]), []byte(expected)) ||
		!hasClaimValue(values[forwardedTokenHeader]) || !hasClaimValue(values[forwardedUserIDHeader]) {
		return false
	}
	for _, name := range names[1:] {
		if hasClaimValue(values[name]) {
			headers.Set(name, values[name])
		}
	}
	return true
}

// App Auth uses secure HTTPS hosts. Reject credentialed cross-origin API
// requests even when a browser sends the OIDC session cookie.
func sameOriginForwarding(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || origin == "https://"+r.Host
}
