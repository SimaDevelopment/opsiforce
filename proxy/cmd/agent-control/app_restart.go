package main

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
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

var appRestartUsage = fmt.Sprintf(`app-restart — run startup.sh again from the top, or restart one process it supervises.

Usage:
  app-restart              run startup.sh again, so an edit to it takes effect now
  app-restart <process>    restart one process startup.sh supervises, by its guard name

Use the first form after you add, remove or change a line in startup.sh: a new guard line,
an install step, a changed command. It stops startup.sh and every process it started, waits
for the platform to run startup.sh again, and returns. The App is down for a few seconds
meanwhile. In process-logs the restart shows as webapp crashed with exit_code=143 and a
signal event for each process startup.sh started: that is this restart, not a crash.

Use the second form when one process must reread something it loads only at start: new
dependencies, a changed config or environment file. It stops everything running under
`+"`guard <process>`"+`, waits until guard has started the command again, and returns. guard
and every other process keep running; the platform's own processes are refused. In
process-logs it shows as that process stopped, or crashed with exit_code=143, and started
again: that is this restart, not a crash.

Restarts close together wait longer each time (guard's backoff).
A change to the App's own code needs no restart: its dev servers reload on save.

Examples:
  app-restart && process-logs --events --since 1m     rerun, then see what started
  app-restart worker && process-logs -n 20 worker     restart one process, then read it

Exit codes:
  0  startup.sh, or the named process, is running again
  1  nothing to restart: no startup.sh is running yet (it starts by itself once it exists
     and is executable), or startup.sh supervises no process by that name
  2  wrong usage
  3  it did not start again within %[1]ds; read process-logs webapp, or process-logs <process>

Options:
  -h, --help  this help
`, int(appRestartWaitLimit.Seconds()))

func runAppRestartCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 1 && !strings.HasPrefix(args[0], "-") {
		return restartSupervisedProcess(args[0], stdout, stderr)
	}
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
	children := childrenByParent(procs)

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

func restartSupervisedProcess(name string, stdout, stderr io.Writer) int {
	procs := listProcs()
	targets, supervised := supervisedProcessTargets(procs, name, os.Getpid())
	if !supervised {
		fmt.Fprintf(stderr, "Nothing to restart: startup.sh supervises no process named %q.", name)
		if names := supervisedNames(procs); len(names) > 0 {
			fmt.Fprintf(stderr, " It supervises: %s.", strings.Join(names, ", "))
		}
		fmt.Fprintln(stderr, " To run startup.sh again, use app-restart without a name.")
		return 1
	}
	before := currentRuns(procs, name)

	stop(targets)

	deadline := time.Now().Add(appRestartWaitLimit)
	for time.Now().Before(deadline) {
		for run := range currentRuns(listProcs(), name) {
			if !before[run] {
				fmt.Fprintf(stdout, "%[1]s is running again. Read what it printed with: process-logs --since 1m %[1]s\n", name)
				fmt.Fprintln(stdout, "There, stopped or crashed with exit_code=143 is this restart, not a crash.")
				return 0
			}
		}
		time.Sleep(appRestartPollInterval)
	}
	fmt.Fprintf(stderr, "%[1]s did not start again within %[2]ds. Read why with: process-logs %[1]s\n", name, int(appRestartWaitLimit.Seconds()))
	return 3
}

func supervisedProcessTargets(procs map[int]*proc, name string, self int) (map[int]bool, bool) {
	children := childrenByParent(procs)
	targets := map[int]bool{}
	var below func(pid int)
	below = func(pid int) {
		for _, childPid := range children[pid] {
			if childPid == self || isLogWriter(procs[childPid].args) {
				continue
			}
			targets[childPid] = true
			below(childPid)
		}
	}

	supervised := false
	for pid, guarded := range appGuards(procs) {
		if guarded == name {
			supervised = true
			below(pid)
		}
	}
	return targets, supervised
}

func appGuards(procs map[int]*proc) map[int]string {
	children := childrenByParent(procs)
	guards := map[int]string{}
	var below func(pid int)
	below = func(pid int) {
		for _, childPid := range children[pid] {
			if name := guardName(procs[childPid].args); name != "" {
				guards[childPid] = name
			}
			below(childPid)
		}
	}
	for _, p := range procs {
		if guardName(p.args) == appRootGuard {
			below(p.pid)
		}
	}
	return guards
}

func currentRuns(procs map[int]*proc, name string) map[int]bool {
	children := childrenByParent(procs)
	runs := map[int]bool{}
	for pid, guarded := range appGuards(procs) {
		if guarded != name {
			continue
		}
		for _, childPid := range children[pid] {
			if capturesCommandOutput(procs[childPid].args) {
				runs[childPid] = true
			}
		}
	}
	return runs
}

func capturesCommandOutput(args []string) bool {
	if !isLogWriter(args) {
		return false
	}
	for _, arg := range args {
		if arg == "--line" || arg == "--event" {
			return false
		}
	}
	return true
}

func supervisedNames(procs map[int]*proc) []string {
	seen := map[string]bool{}
	for _, name := range appGuards(procs) {
		seen[name] = true
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func childrenByParent(procs map[int]*proc) map[int][]int {
	children := map[int][]int{}
	for _, p := range procs {
		children[p.ppid] = append(children[p.ppid], p.pid)
	}
	return children
}

func runsStartupScript(args []string) bool {
	for _, arg := range args {
		if arg == startupScript {
			return true
		}
	}
	return false
}
