package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultPort   = "4910"
	tokenHeader   = "x-control-token"
	termGrace     = 2 * time.Second
	termPollEvery = 100 * time.Millisecond
)

const appRootGuard = "webapp"

func main() {
	go runOpencodeAuthProxy()
	go runReporter()
	go runStatusWatcher()

	token := os.Getenv("OPSIFORCE_CONTROL_TOKEN")
	if token == "" {
		log.Println("OPSIFORCE_CONTROL_TOKEN not set; control server disabled")
		select {}
	}

	port := os.Getenv("CONTROL_PORT")
	if port == "" {
		port = defaultPort
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /notify-config-change", authorized(token, handleNotifyConfigChange))
	mux.HandleFunc("POST /restart-app", authorized(token, func(w http.ResponseWriter, _ *http.Request) {
		killed := restartAppProcesses()
		log.Printf("restart-app: killed %d processes", killed)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]int{"killed": killed}); err != nil {
			log.Printf("restart-app: failed to write response: %v", err)
		}
	}))

	log.Printf("agent-control listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("agent-control server failed: %v", err)
	}
}

func authorized(token string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		provided := r.Header.Get(tokenHeader)
		if subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		handler(w, r)
	}
}

type proc struct {
	pid  int
	ppid int
	args []string
}

func restartAppProcesses() int {
	targets := appRestartTargets(listProcs())

	for pid := range targets {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}

	deadline := time.Now().Add(termGrace)
	for time.Now().Before(deadline) {
		if !anyAlive(targets) {
			break
		}
		time.Sleep(termPollEvery)
	}
	for pid := range targets {
		if isAlive(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return len(targets)
}

func appRestartTargets(procs map[int]*proc) map[int]bool {
	children := map[int][]int{}
	for _, p := range procs {
		children[p.ppid] = append(children[p.ppid], p.pid)
	}

	targets := map[int]bool{}
	var supervisedBy func(pid int)
	supervisedBy = func(pid int) {
		for _, childPid := range children[pid] {
			child, ok := procs[childPid]
			if !ok || isLogWriter(child.args) {
				continue
			}
			targets[childPid] = true
			supervisedBy(childPid)
		}
	}
	var nestedGuardsUnder func(pid int)
	nestedGuardsUnder = func(pid int) {
		for _, childPid := range children[pid] {
			child, ok := procs[childPid]
			if !ok {
				continue
			}
			if guardName(child.args) != "" {
				supervisedBy(childPid)
				continue
			}
			nestedGuardsUnder(childPid)
		}
	}

	for _, p := range procs {
		if guardName(p.args) == appRootGuard {
			nestedGuardsUnder(p.pid)
		}
	}
	return targets
}

func guardName(args []string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i][strings.LastIndex(args[i], "/")+1:] == "guard" {
			return args[i+1]
		}
	}
	return ""
}

func isLogWriter(args []string) bool {
	return len(args) > 0 && strings.Contains(args[0], "log-writer")
}

func anyAlive(pids map[int]bool) bool {
	for pid := range pids {
		if isAlive(pid) {
			return true
		}
	}
	return false
}

func isAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func listProcs() map[int]*proc {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	procs := map[int]*proc{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}

		stat, err := os.ReadFile("/proc/" + entry.Name() + "/stat")
		if err != nil {
			continue
		}
		closeParen := strings.LastIndexByte(string(stat), ')')
		if closeParen == -1 {
			continue
		}
		fields := strings.Fields(string(stat)[closeParen+1:])
		if len(fields) < 2 {
			continue
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}

		cmdline, err := os.ReadFile("/proc/" + entry.Name() + "/cmdline")
		if err != nil {
			continue
		}
		args := strings.FieldsFunc(string(cmdline), func(r rune) bool { return r == 0 })

		procs[pid] = &proc{pid: pid, ppid: ppid, args: args}
	}
	return procs
}
