package config

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"
)

type Mode string

const (
	ModeAgent  Mode = "agent"
	ModeApp    Mode = "app"
	ModeVSCode Mode = "vscode"
	ModeDB     Mode = "db"

	ModeExternalService Mode = "external-service"
)

const maxCallerCacheTTL = 5 * time.Second

type Config struct {
	Mode                        Mode
	Port                        int
	BackendURL                  string
	ProxyControlToken           string
	AppAuthForwardingSigningKey string
	StorageMountPath            string
	ReadyCacheTTL               time.Duration
	NonReadyCacheTTL            time.Duration
	ControlPlaneTimeout         time.Duration
	WebsocketKeepAliveInterval  time.Duration
	CompressionMinBytes         int
	RequestBufferLimit          int64
	RequestLogBodyLimit         int
	RequestLogQueueDepth        int
	ControlPort                 int
	WebhookPort                 int
	ServiceStartHold            time.Duration
	CallerCacheTTL              time.Duration
}

func Load(modeArg string, portArg int) (Config, error) {
	mode, err := parseMode(firstNonEmpty(modeArg, os.Getenv("OPSIFORCE_PROXY_MODE")))
	if err != nil {
		return Config{}, err
	}

	return Config{
		Mode:                        mode,
		Port:                        intEnv("PORT", defaultPort(mode, portArg)),
		BackendURL:                  strings.TrimRight(firstNonEmpty(os.Getenv("OPSIFORCE_BACKEND_URL"), "http://localhost:3001"), "/"),
		ProxyControlToken:           firstNonEmpty(os.Getenv("PROXY_CONTROL_TOKEN"), "opsiforce-local-proxy-token"),
		AppAuthForwardingSigningKey: os.Getenv("APP_AUTH_FORWARDING_SIGNING_KEY"),
		StorageMountPath:            firstNonEmpty(os.Getenv("STORAGE_MOUNT_PATH"), "/workspace-data"),
		ReadyCacheTTL:               durationEnv("OPSIFORCE_PROXY_READY_CACHE_TTL", 5*time.Second),
		NonReadyCacheTTL:            durationEnv("OPSIFORCE_PROXY_NON_READY_CACHE_TTL", time.Second),
		ControlPlaneTimeout:         durationEnv("OPSIFORCE_PROXY_CONTROL_TIMEOUT", 10*time.Second),
		WebsocketKeepAliveInterval:  positiveDurationEnv("OPSIFORCE_PROXY_WS_KEEPALIVE_INTERVAL", time.Minute),
		CompressionMinBytes:         intEnv("OPSIFORCE_PROXY_COMPRESSION_MIN_BYTES", 1024),
		RequestBufferLimit:          int64(intEnv("OPSIFORCE_PROXY_REQUEST_BUFFER_LIMIT_BYTES", 3*1024*1024)),
		RequestLogBodyLimit:         intEnv("OPSIFORCE_PROXY_REQUEST_LOG_BODY_LIMIT_BYTES", 256*1024),
		RequestLogQueueDepth:        intEnv("OPSIFORCE_PROXY_REQUEST_LOG_QUEUE_DEPTH", 32),
		ControlPort:                 intEnv("OPSIFORCE_PROXY_CONTROL_PORT", 3007),
		WebhookPort:                 intEnv("OPSIFORCE_PROXY_WEBHOOK_PORT", 3008),
		ServiceStartHold:            positiveDurationEnv("OPSIFORCE_PROXY_SERVICE_START_HOLD", 65*time.Second),
		CallerCacheTTL:              min(positiveDurationEnv("OPSIFORCE_PROXY_CALLER_CACHE_TTL", maxCallerCacheTTL), maxCallerCacheTTL),
	}, nil
}

func parseMode(value string) (Mode, error) {
	switch Mode(value) {
	case ModeAgent, ModeApp, ModeVSCode, ModeDB, ModeExternalService:
		return Mode(value), nil
	default:
		return "", errors.New("invalid proxy mode")
	}
}

func defaultPort(mode Mode, portArg int) int {
	if portArg > 0 {
		return portArg
	}

	switch mode {
	case ModeAgent:
		return 3005
	case ModeApp:
		return 3002
	case ModeVSCode:
		return 3003
	case ModeDB:
		return 3004
	case ModeExternalService:
		return 3006
	default:
		return 3005
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}

	return ""
}

func intEnv(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}

	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}

	return value
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}

	value, err := time.ParseDuration(raw)
	if err != nil {
		return fallback
	}

	return value
}

// positiveDurationEnv reads a duration that drives a ticker. "0s" and negative
// durations parse cleanly but panic time.NewTicker, so they fall back to the
// default instead of reaching it.
func positiveDurationEnv(name string, fallback time.Duration) time.Duration {
	value := durationEnv(name, fallback)
	if value <= 0 {
		return fallback
	}

	return value
}
