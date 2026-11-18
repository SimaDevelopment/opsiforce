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
	for _, wrong := range [][]string{{"--now"}, {"worker", "store"}} {
		code, stdout, stderr := runCLI("", append([]string{appRestartCommand}, wrong...)...)
		if code != 2 || stdout != "" || !strings.Contains(stderr, "Usage:") {
			t.Fatalf("wrong usage %v: code %d, stdout %q, stderr %q", wrong, code, stdout, stderr)
		}
	}
}

func podWithBackendAndStore(extra ...*proc) map[int]*proc {
	return podWith(append([]*proc{
		guardProc(20, 11, "app-backend", "yarn", "dev:backend"),
		{pid: 21, ppid: 20, args: []string{"node", "yarn", "dev:backend"}},
		{pid: 22, ppid: 21, args: []string{"node", "backend/src/main.ts"}},
		logWriterProc(23, 20, "app-backend"),
		guardProc(30, 11, "store", "store-server", "--foreground"),
		{pid: 31, ppid: 30, args: []string{"store-server", "--foreground"}},
		logWriterProc(32, 30, "store"),
	}, extra...)...)
}

func TestProcessRestartStopsWhatRunsUnderItsGuardAndNothingElse(t *testing.T) {
	targets, supervised := supervisedProcessTargets(podWithBackendAndStore(), "app-backend", 999)
	want := map[int]bool{21: true, 22: true}
	if !supervised || !reflect.DeepEqual(targets, want) {
		t.Fatalf("supervised = %v, targets = %v; want %v (its guard, its log writer and the other processes stay)", supervised, targets, want)
	}
}

func TestProcessRestartCutsShortTheWaitBeforeGuardsNextStart(t *testing.T) {
	procs := podWith(
		guardProc(20, 11, "app-backend", "yarn", "dev:backend"),
		&proc{pid: 26, ppid: 20, args: []string{"sleep", "8"}},
	)

	targets, supervised := supervisedProcessTargets(procs, "app-backend", 999)
	if want := (map[int]bool{26: true}); !supervised || !reflect.DeepEqual(targets, want) {
		t.Fatalf("supervised = %v, targets = %v; want %v", supervised, targets, want)
	}
}

func TestProcessRestartNeverStopsTheProcessThatAskedForIt(t *testing.T) {
	procs := podWithBackendAndStore(&proc{pid: 25, ppid: 22, args: []string{"agent-control", "app-restart", "app-backend"}})

	if targets, _ := supervisedProcessTargets(procs, "app-backend", 25); targets[25] {
		t.Fatalf("targets = %v include the caller", targets)
	}
}

func TestProcessRestartFindsNothingUnderANameGuardDoesNotSupervise(t *testing.T) {
	procs := podWithBackendAndStore()

	targets, supervised := supervisedProcessTargets(procs, "worker", 999)
	if supervised || len(targets) != 0 {
		t.Fatalf("supervised = %v, targets = %v; want nothing", supervised, targets)
	}
	if got, want := supervisedNames(procs), []string{"app-backend", "store"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("names offered instead = %v, want %v", got, want)
	}
}

func TestProcessRestartLeavesThePlatformsOwnProcessesAlone(t *testing.T) {
	for _, name := range []string{"opencode", "webapp"} {
		if targets, supervised := supervisedProcessTargets(podWithBackendAndStore(), name, 999); supervised || len(targets) != 0 {
			t.Fatalf("%s: supervised = %v, targets = %v; want it refused", name, supervised, targets)
		}
	}
}

func TestARunIsCountedOnceTheCommandsOutputIsCapturedNotWhenGuardWritesANote(t *testing.T) {
	procs := podWithBackendAndStore(
		&proc{pid: 27, ppid: 20, args: []string{"/usr/local/bin/log-writer", "--name", "app-backend", "--line", "[guard:app-backend] Starting"}},
		&proc{pid: 28, ppid: 20, args: []string{"/usr/local/bin/log-writer", "--name", "app-backend", "--event", "started"}},
	)

	if got, want := currentRuns(procs, "app-backend"), (map[int]bool{23: true}); !reflect.DeepEqual(got, want) {
		t.Fatalf("runs = %v, want %v", got, want)
	}
}

func TestAppRestartRefusesANameGuardDoesNotSupervise(t *testing.T) {
	code, stdout, stderr := runCLI("", appRestartCommand, "no-such-process")
	if code != 1 || stdout != "" || !strings.Contains(stderr, `"no-such-process"`) || !strings.Contains(stderr, "app-restart without a name") {
		t.Fatalf("code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}
