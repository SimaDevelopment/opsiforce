package main

import (
	"bytes"
	"strings"
	"testing"
)

func runCLI(gatewayURL string, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runSubcommand(args, gatewayURL, gatewayKey, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestAppURLHelpPrintsUsageWithoutAskingThePlatform(t *testing.T) {
	gateway, gatewayURL := startFakeGateway(t, `{"publicUrl":"https://app.example-org.test/","servesAnExternalService":false}`)
	for _, flag := range []string{"-h", "--help"} {
		code, stdout, _ := runCLI(gatewayURL, appURLCommand, flag)
		if code != 0 || !strings.Contains(stdout, "Examples:") {
			t.Fatalf("app-url %s: code %d, stdout %q", flag, code, stdout)
		}
	}
	if gateway.asked != 0 {
		t.Fatalf("help asked the platform %d times", gateway.asked)
	}
}

func TestAppURLRefusesArgumentsWithItsUsage(t *testing.T) {
	gateway, gatewayURL := startFakeGateway(t, `{"publicUrl":"https://app.example-org.test/","servesAnExternalService":false}`)
	code, stdout, stderr := runCLI(gatewayURL, appURLCommand, "--production")
	if code != 2 || stdout != "" || !strings.Contains(stderr, "Usage:") {
		t.Fatalf("code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
	if gateway.asked != 0 {
		t.Fatalf("wrong usage asked the platform %d times", gateway.asked)
	}
}

func TestAgentControlHelpPrintsUsageInsteadOfStartingTheServer(t *testing.T) {
	for _, flag := range []string{"-h", "--help"} {
		code, stdout, _ := runCLI("", flag)
		if code != 0 || !strings.Contains(stdout, "app-url") {
			t.Fatalf("agent-control %s: code %d, stdout %q", flag, code, stdout)
		}
	}
}

func TestAgentControlRefusesAnUnknownSubcommand(t *testing.T) {
	code, stdout, stderr := runCLI("", "status")
	if code != 2 || stdout != "" || !strings.Contains(stderr, "Usage:") {
		t.Fatalf("code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}
