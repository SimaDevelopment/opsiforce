package main

import (
	"fmt"
	"io"
	"os"
	"time"
)

const (
	appRestartCommand = "app-restart"
	startupScript     = "/workspace/app/startup.sh"
)

const (
	appRestartPollInterval = 250 * time.Millisecond
	appRestartWaitLimit    = 75 * time.Second
)

var appRestartUsage = fmt.Sprintf(`app-restart — run startup.sh again from the top, so an edit to it takes effect now.

Usage:
  app-restart

Use it after you add, remove or change a line in startup.sh: a new guard line, an install
step, a changed command. It stops startup.sh and every process it started, waits for the
platform to run startup.sh again, and returns. The App is down for a few seconds meanwhile.
In process-logs the restart shows as webapp crashed with exit_code=143 and a signal event
for each process startup.sh started: that is this restart, not a crash. Restarts close
together wait longer each time (guard's backoff).
A change to the App's own code needs no restart: its dev servers reload on save.

Examples:
  app-restart && process-logs --events --since 1m     rerun, then see what started
  app-restart && process-logs -n 20 worker            rerun, then read one new process

Exit codes:
  0  startup.sh is running again
  1  there is no startup.sh running yet; it starts by itself once it exists and is executable
  2  wrong usage
  3  startup.sh did not start again within %[1]ds; read process-logs webapp

Options:
  -h, --help  this help
`, int(appRestartWaitLimit.Seconds()))

func runAppRestartCommand(args []string, stdout, stderr io.Writer) int {
	if code, handled := helpOrRefuse(args, appRestartUsage, stdout, stderr); handled {
		return code
	}

	targets, startup := startupRerunTargets(listProcs(), os.Getpid())
	if startup == 0 {
		fmt.Fprintln(stderr, "Nothing to restart: "+startupScript+" is not running yet. It starts by itself once it exists and is executable.")
		return 1
	}

	stop(targets)

	deadline := time.Now().Add(appRestartWaitLimit)
	for time.Now().Before(deadline) {
		if _, next := startupRerunTargets(listProcs(), os.Getpid()); next != 0 && next != startup {
			fmt.Fprintln(stdout, "startup.sh is running again. See what it started with: process-logs --events --since 1m")
			fmt.Fprintln(stdout, "There, webapp crashed with exit_code=143 and the signal events are this restart, not a crash.")
			return 0
		}
		time.Sleep(appRestartPollInterval)
	}
	fmt.Fprintf(stderr, "startup.sh did not start again within %ds. Read why with: process-logs webapp\n", int(appRestartWaitLimit.Seconds()))
	return 3
}

func startupRerunTargets(procs map[int]*proc, self int) (map[int]bool, int) {
	children := map[int][]int{}
	for _, p := range procs {
		children[p.ppid] = append(children[p.ppid], p.pid)
	}

	startup := 0
	for _, p := range procs {
		if guardName(p.args) != appRootGuard {
			continue
		}
		for _, childPid := range children[p.pid] {
			if child := procs[childPid]; child != nil && runsStartupScript(child.args) {
				startup = childPid
			}
		}
	}
	if startup == 0 {
		return map[int]bool{}, 0
	}

	targets := map[int]bool{startup: true}
	var below func(pid int)
	below = func(pid int) {
		for _, childPid := range children[pid] {
			child := procs[childPid]
			if child == nil || childPid == self || isLogWriter(child.args) {
				continue
			}
			targets[childPid] = true
			below(childPid)
		}
	}
	below(startup)
	return targets, startup
}

func runsStartupScript(args []string) bool {
	for _, arg := range args {
		if arg == startupScript {
			return true
		}
	}
	return false
}
