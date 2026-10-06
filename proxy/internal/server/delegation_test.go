package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
)

func delegationFixture(env string) http.Header {
	key := strings.Repeat("k", 32)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("app-oauth:" + env))
	h := http.Header{}
	h.Set(delegationProof, hex.EncodeToString(mac.Sum(nil)))
	h.Set(delegationToken, "user-token")
	h.Set("X-Opsiforce-Tenant-Id", "tenant")
	h.Set("X-Opsiforce-User-Id", "user")
	return h
}

func TestDelegationBoundary(t *testing.T) {
	key := strings.Repeat("k", 32)
	t.Run("authenticated request keeps only app credentials", func(t *testing.T) {
		h := delegationFixture("env-a")
		h.Set("X-Opsiforce-Unknown", "untrusted")
		if !acceptDelegation(h, "env-a", key) {
			t.Fatal("rejected valid transport credential")
		}
		if h.Get(delegationToken) != "user-token" || h.Get(delegationProof) != "" || h.Get("X-Opsiforce-Unknown") != "" {
			t.Fatal("incorrect forwarding")
		}
	})
	for _, scenario := range []string{"missing-proof", "wrong-environment", "duplicate-token", "case-duplicate", "weak-key"} {
		t.Run(scenario, func(t *testing.T) {
			h := delegationFixture("env-a")
			env := "env-a"
			testKey := key
			switch scenario {
			case "missing-proof":
				h.Del(delegationProof)
			case "wrong-environment":
				env = "env-b"
			case "duplicate-token":
				h.Add(delegationToken, "attacker")
			case "case-duplicate":
				h["x-opsiforce-access-token"] = []string{"attacker"}
			case "weak-key":
				testKey = strings.Repeat("k", 31)
			}
			if acceptDelegation(h, env, testKey) {
				t.Fatal("accepted forged delegation")
			}
			for name := range h {
				if strings.HasPrefix(strings.ToLower(name), delegationPrefix) {
					t.Fatal("delegation header survived rejection")
				}
			}
		})
	}
}

func TestDelegationNeverAppearsInLogsOrResponseHeaders(t *testing.T) {
	h := delegationFixture("env-a")
	logged := jsonHeader(h)
	if strings.Contains(logged, "user-token") || strings.Contains(logged, h.Get(delegationProof)) {
		t.Fatal("credential logged")
	}
	for name := range filterResponseHeaders(h, false) {
		if strings.HasPrefix(strings.ToLower(name), delegationPrefix) {
			t.Fatal("response credential leaked")
		}
	}
	sanitizeReverseProxyHeaders(h, false)
	if len(h) != 0 {
		t.Fatal("upgrade response credential leaked")
	}
}

func TestDelegationOrigin(t *testing.T) {
	for _, origin := range []string{"", "https://app.example", "https://evil.example", "null"} {
		r, _ := http.NewRequest("GET", "https://app.example/api/files", nil)
		r.Header.Set("Origin", origin)
		if sameOriginDelegation(r) != (origin == "" || origin == "https://app.example") {
			t.Fatal("wrong origin policy", origin)
		}
	}
}
