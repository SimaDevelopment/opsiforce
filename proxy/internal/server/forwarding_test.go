package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
)

func forwardingFixture(env string) http.Header {
	key := strings.Repeat("k", 32)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("app-auth-forwarding:" + env))
	h := http.Header{}
	h.Set(forwardingProofHeader, hex.EncodeToString(mac.Sum(nil)))
	h.Set(forwardedTokenHeader, "user-token")
	h.Set(forwardedUserIDHeader, "user")
	h.Set(objectIDHeader, "object")
	h.Set(directoryIDHeader, "tenant")
	return h
}

func TestForwardingBoundary(t *testing.T) {
	key := strings.Repeat("k", 32)
	t.Run("authenticated request keeps only app credentials", func(t *testing.T) {
		h := forwardingFixture("env-a")
		h.Set("X-Opsiforce-Unknown", "untrusted")
		if !acceptForwarding(h, "env-a", key) {
			t.Fatal("rejected valid transport credential")
		}
		if h.Get(forwardedTokenHeader) != "user-token" || h.Get(forwardingProofHeader) != "" || h.Get("X-Opsiforce-Unknown") != "" {
			t.Fatal("incorrect forwarding")
		}
	})
	t.Run("provider without oid and tid forwards only the user id", func(t *testing.T) {
		h := forwardingFixture("env-a")
		h.Set(objectIDHeader, "<no value>")
		h.Set(directoryIDHeader, "")
		if !acceptForwarding(h, "env-a", key) {
			t.Fatal("rejected request without oid and tid claims")
		}
		if h.Get(forwardedUserIDHeader) != "user" || len(h.Values(objectIDHeader)) != 0 || len(h.Values(directoryIDHeader)) != 0 {
			t.Fatal("forwarded a missing optional claim")
		}
	})
	for _, scenario := range []string{"missing-proof", "wrong-environment", "duplicate-token", "case-duplicate", "weak-key", "missing-user", "empty-user"} {
		t.Run(scenario, func(t *testing.T) {
			h := forwardingFixture("env-a")
			env := "env-a"
			testKey := key
			switch scenario {
			case "missing-proof":
				h.Del(forwardingProofHeader)
			case "wrong-environment":
				env = "env-b"
			case "duplicate-token":
				h.Add(forwardedTokenHeader, "attacker")
			case "case-duplicate":
				h["x-opsiforce-access-token"] = []string{"attacker"}
			case "weak-key":
				testKey = strings.Repeat("k", 31)
			case "missing-user":
				h.Set(forwardedUserIDHeader, "<no value>")
			case "empty-user":
				h.Set(forwardedUserIDHeader, "")
			}
			if acceptForwarding(h, env, testKey) {
				t.Fatal("accepted forged forwarding proof")
			}
			for name := range h {
				if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
					t.Fatal("reserved header survived rejection")
				}
			}
		})
	}
}

func TestForwardingNeverAppearsInLogsOrResponseHeaders(t *testing.T) {
	h := forwardingFixture("env-a")
	logged := jsonHeader(h)
	if strings.Contains(logged, "user-token") || strings.Contains(logged, h.Get(forwardingProofHeader)) {
		t.Fatal("credential logged")
	}
	for name := range filterResponseHeaders(h, false) {
		if strings.HasPrefix(strings.ToLower(name), reservedHeaderPrefix) {
			t.Fatal("response credential leaked")
		}
	}
	sanitizeReverseProxyHeaders(h, false)
	if len(h) != 0 {
		t.Fatal("upgrade response credential leaked")
	}
}

func TestForwardingOrigin(t *testing.T) {
	for _, origin := range []string{"", "https://app.example", "https://evil.example", "null"} {
		r, _ := http.NewRequest("GET", "https://app.example/api/files", nil)
		r.Header.Set("Origin", origin)
		if sameOriginForwarding(r) != (origin == "" || origin == "https://app.example") {
			t.Fatal("wrong origin policy", origin)
		}
	}
}
