package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestRerunStopsStartupShAndEverythingItStartedButKeepsItsSupervisor(t *testing.T) {
	procs := podWith(
		guardProc(20, 11, "app-backend", "yarn", "dev:backend"),
		&proc{pid: 21, ppid: 20, args: []string{"node", "yarn", "dev:backend"}},
		&proc{pid: 22, ppid: 21, args: []string{"node", "backend/src/main.ts"}},
		logWriterProc(23, 20, "app-backend"),
		&proc{pid: 24, ppid: 11, args: []string{"sleep", "5"}},
	)

	targets, startup := startupRerunTargets(procs, 999)
	want := map[int]bool{11: true, 20: true, 21: true, 22: true, 24: true}
	if startup != 11 || !reflect.DeepEqual(targets, want) {
		t.Fatalf("startup = %d, targets = %v; want 11 and %v (webapp's guard, log writers and other guards stay)", startup, targets, want)
	}
}

func TestRerunFindsNothingBeforeStartupShExists(t *testing.T) {
	procs := procTable(
		guardProc(10, 1, "webapp", "sh", "-c", "while [ ! -x /workspace/app/startup.sh ]; do sleep 2; done; exec /workspace/app/startup.sh"),
		&proc{pid: 11, ppid: 10, args: []string{"sh", "-c", "while [ ! -x /workspace/app/startup.sh ]; do sleep 2; done; exec /workspace/app/startup.sh"}},
		logWriterProc(12, 10, "webapp"),
	)

	if targets, startup := startupRerunTargets(procs, 999); startup != 0 || len(targets) != 0 {
		t.Fatalf("startup = %d, targets = %v; want nothing while the App's guard is still waiting for startup.sh", startup, targets)
	}
}

func TestRerunNeverStopsTheProcessThatAskedForIt(t *testing.T) {
	procs := podWith(&proc{pid: 30, ppid: 11, args: []string{"app-restart"}})

	targets, _ := startupRerunTargets(procs, 30)
	if targets[30] {
		t.Fatalf("targets = %v include the caller", targets)
	}
}

func TestAppRestartHelpAndWrongUsage(t *testing.T) {
	code, stdout, _ := runCLI("", appRestartCommand, "--help")
	if code != 0 || !strings.Contains(stdout, "Examples:") {
		t.Fatalf("--help: code %d, stdout %q", code, stdout)
	}
	code, stdout, stderr := runCLI("", appRestartCommand, "--now")
	if code != 2 || stdout != "" || !strings.Contains(stderr, "Usage:") {
		t.Fatalf("wrong usage: code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}
