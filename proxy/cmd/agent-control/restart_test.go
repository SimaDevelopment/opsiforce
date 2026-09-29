package main

import (
	"reflect"
	"testing"
)

func procTable(entries ...*proc) map[int]*proc {
	table := map[int]*proc{}
	for _, p := range entries {
		table[p.pid] = p
	}
	return table
}

func guardProc(pid, ppid int, name string, command ...string) *proc {
	return &proc{pid: pid, ppid: ppid, args: append([]string{"/bin/bash", "/usr/local/bin/guard", name}, command...)}
}

func logWriterProc(pid, ppid int, name string) *proc {
	return &proc{pid: pid, ppid: ppid, args: []string{"/usr/local/bin/log-writer", "--name", name}}
}

func podWith(startupChildren ...*proc) map[int]*proc {
	return procTable(append([]*proc{
		{pid: 1, ppid: 0, args: []string{"/bin/bash", "/usr/local/bin/entrypoint.sh"}},
		guardProc(10, 1, "webapp", "sh", "-c", "while [ ! -x /workspace/app/startup.sh ]; do sleep 2; done; exec /workspace/app/startup.sh"),
		logWriterProc(12, 10, "webapp"),
		{pid: 11, ppid: 10, args: []string{"/bin/bash", "/workspace/app/startup.sh"}},
		guardProc(40, 1, "opencode", "opencode2", "serve"),
		{pid: 41, ppid: 40, args: []string{"opencode2", "serve"}},
	}, startupChildren...)...)
}

func TestRestartTargetsEveryProcessStartupShSupervisesWhateverItsName(t *testing.T) {
	procs := podWith(
		guardProc(20, 11, "app-backend", "yarn", "dev:backend"),
		&proc{pid: 21, ppid: 20, args: []string{"node", "yarn", "dev:backend"}},
		&proc{pid: 22, ppid: 21, args: []string{"node", "backend/src/main.ts"}},
		logWriterProc(23, 20, "app-backend"),
		guardProc(30, 11, "store", "store-server", "--foreground"),
		&proc{pid: 31, ppid: 30, args: []string{"store-server", "--foreground"}},
		logWriterProc(32, 30, "store"),
	)

	got := appRestartTargets(procs)
	want := map[int]bool{21: true, 22: true, 31: true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("targets = %v, want %v (guards, startup.sh, log writers and non-App guards stay)", got, want)
	}
}

func TestRestartTargetsNothingWhenStartupShSupervisesNothing(t *testing.T) {
	procs := podWith(&proc{pid: 20, ppid: 11, args: []string{"node", "server.js"}})

	if got := appRestartTargets(procs); len(got) != 0 {
		t.Fatalf("targets = %v, want none: an unsupervised server cannot be restarted in place", got)
	}
}

func TestRestartTargetsNothingBeforeStartupShExists(t *testing.T) {
	procs := procTable(
		guardProc(10, 1, "webapp", "sh", "-c", "while [ ! -x /workspace/app/startup.sh ]; do sleep 2; done"),
		&proc{pid: 11, ppid: 10, args: []string{"sh", "-c", "while [ ! -x /workspace/app/startup.sh ]; do sleep 2; done"}},
		&proc{pid: 13, ppid: 11, args: []string{"sleep", "2"}},
	)

	if got := appRestartTargets(procs); len(got) != 0 {
		t.Fatalf("targets = %v, want none", got)
	}
}
