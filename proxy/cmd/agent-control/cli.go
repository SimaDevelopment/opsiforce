package main

import (
	"fmt"
	"io"
)

const agentControlUsage = `agent-control — the pod's control process, started by the platform under ` + "`guard control`" + `.
Never start it by hand: the running one restarts the App on request, reports when it goes
live and fronts the chat. Its commands for you are app-url and app-restart.

Usage:
  agent-control app-url       print the App's public URL (the same as ` + "`app-url`" + `)
  agent-control app-restart   run startup.sh again now (the same as ` + "`app-restart`" + `)
  agent-control --help        this help

Wrong usage prints this help to stderr and exits 2 without starting anything.
`

const appURLUsage = `app-url — print the public address of this Project's App, the link to share with the user.

Usage:
  app-url

Asks the platform for the App's current public URL and prints it on one line, waiting up
to 30s while the App comes up. The address can change after go-live, so run it again
whenever you share the link instead of reusing an old one. Never share a localhost address.

Examples:
  app-url                         print the link to share
  curl -sI "$(app-url)"           check what the public address answers

Exit codes:
  0  printed the URL
  1  the App isn't live yet, or this Project serves an External Service and has no App
  2  wrong usage, or SERVICE_GATEWAY_URL / SERVICE_GATEWAY_API_KEY are not set
  3  the platform could not be reached

Options:
  -h, --help  this help
`

func runSubcommand(args []string, gatewayURL, key string, stdout, stderr io.Writer) int {
	switch args[0] {
	case appURLCommand:
		return runAppURLCommand(args[1:], gatewayURL, key, stdout, stderr)
	case appRestartCommand:
		return runAppRestartCommand(args[1:], stdout, stderr)
	}
	code, _ := helpOrRefuse(args, agentControlUsage, stdout, stderr)
	return code
}

func helpOrRefuse(args []string, usage string, stdout, stderr io.Writer) (code int, handled bool) {
	switch {
	case len(args) == 1 && (args[0] == "-h" || args[0] == "--help"):
		fmt.Fprint(stdout, usage)
		return 0, true
	case len(args) > 0:
		fmt.Fprint(stderr, usage)
		return 2, true
	}
	return 0, false
}

func runAppURLCommand(args []string, gatewayURL, key string, stdout, stderr io.Writer) int {
	if code, handled := helpOrRefuse(args, appURLUsage, stdout, stderr); handled {
		return code
	}
	return runAppURL(gatewayURL, key, stdout, stderr)
}
