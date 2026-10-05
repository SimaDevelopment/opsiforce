package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

const delegationPrefix = "x-opsiforce-"
const delegationProof = "X-Opsiforce-Delegation-Proof"
const delegationToken = "X-Opsiforce-Access-Token"

func stripDelegationHeaders(headers http.Header) {
	for name := range headers {
		if strings.HasPrefix(strings.ToLower(name), delegationPrefix) {
			delete(headers, name)
		}
	}
}

// Authenticate the per-environment transport credential injected by OIDC.
// Remove it before the request can reach app code, logs, or another surface.
func acceptDelegation(headers http.Header, environmentID, key string) bool {
	names := []string{delegationProof, delegationToken, "X-Opsiforce-Tenant-Id", "X-Opsiforce-User-Id"}
	values := make(map[string]string)
	valid := len(key) >= 32 && key != "opsiforce-local-proxy-token"
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
	stripDelegationHeaders(headers)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("app-oauth:" + environmentID))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !valid || !hmac.Equal([]byte(values[delegationProof]), []byte(expected)) || values[delegationToken] == "" {
		return false
	}
	for _, name := range names[1:] {
		headers.Set(name, values[name])
	}
	return true
}

// App Auth uses secure HTTPS hosts. Reject credentialed cross-origin API
// requests even when a browser sends the OIDC session cookie.
func sameOriginDelegation(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || origin == "https://"+r.Host
}
