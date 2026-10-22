package config

import (
	"testing"
	"time"
)

func TestPositiveDurationEnvRejectsNonPositive(t *testing.T) {
	const name = "OPSIFORCE_PROXY_TEST_INTERVAL"
	fallback := time.Minute

	for _, raw := range []string{"0s", "0", "-1s", "-5m", "not-a-duration"} {
		t.Setenv(name, raw)
		if got := positiveDurationEnv(name, fallback); got != fallback {
			t.Errorf("positiveDurationEnv(%q) = %v, want fallback %v", raw, got, fallback)
		}
	}
}

func TestPositiveDurationEnvKeepsPositive(t *testing.T) {
	const name = "OPSIFORCE_PROXY_TEST_INTERVAL"

	t.Setenv(name, "30s")
	if got := positiveDurationEnv(name, time.Minute); got != 30*time.Second {
		t.Errorf("positiveDurationEnv = %v, want 30s", got)
	}
}

// The keep-alive interval drives a time.Ticker, which panics on a non-positive
// period — so a hostile env value must never survive Load.
func TestLoadKeepsWebsocketKeepAliveIntervalPositive(t *testing.T) {
	for _, raw := range []string{"0s", "-1s"} {
		t.Setenv("OPSIFORCE_PROXY_WS_KEEPALIVE_INTERVAL", raw)

		cfg, err := Load(string(ModeApp), 0)
		if err != nil {
			t.Fatalf("Load with interval %q: %v", raw, err)
		}
		if cfg.WebsocketKeepAliveInterval <= 0 {
			t.Fatalf("interval %q survived Load as %v", raw, cfg.WebsocketKeepAliveInterval)
		}
	}
}

func TestExternalServiceModeListensOnItsOwnPorts(t *testing.T) {
	cfg, err := Load("external-service", 0)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Mode != ModeExternalService || cfg.Port != 3006 || cfg.ControlPort != 3007 || cfg.WebhookPort != 3008 {
		t.Fatalf("got mode %q port %d control port %d webhook port %d", cfg.Mode, cfg.Port, cfg.ControlPort, cfg.WebhookPort)
	}
	if cfg.ServiceStartHold != 65*time.Second {
		t.Fatalf("hold = %v, want the backend's 60 s plus 5 s for its answer", cfg.ServiceStartHold)
	}
}

func TestCallerCacheNeverLivesLongerThanFiveSeconds(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 5 * time.Second, "1m": 5 * time.Second, "2s": 2 * time.Second, "0s": 5 * time.Second} {
		t.Setenv("OPSIFORCE_PROXY_CALLER_CACHE_TTL", raw)
		cfg, err := Load("external-service", 0)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.CallerCacheTTL != want {
			t.Errorf("OPSIFORCE_PROXY_CALLER_CACHE_TTL=%q gave %v, want %v", raw, cfg.CallerCacheTTL, want)
		}
	}
}
