#!/bin/bash

usage() {
  cat <<'EOF'
guard — keep a long-running process alive and record its output.

Usage:
  guard <name> <command> [args...] &

Use it in startup.sh for every server, worker or daemon the App needs. A one-off command
(a build, an install, a migration, a test run) runs on its own, without guard.

guard runs <command> in the foreground and starts it again whenever it exits, crashed or
not: 2s after the first exit, doubling to 60s, and giving up after 50 restarts in a row that
each ran under 30s; a run of 30s or more resets both. guard itself never returns, so always
end the line with `&`. To restart a supervised process, kill the command, not guard; guard
starts it again. A guard line you add to startup.sh starts once you run `app-restart`.

Examples:
  guard server yarn dev &
  guard worker node worker.js &
  guard api sh -c 'go build -o bin/api . && exec bin/api' &

Output:
  Its output and starts, exits and restarts go to /workspace/data/logs/<name>.log.
  process-logs <name>            read them
  process-logs --events <name>   only starts, exits and restarts

Options:
  -h, --help  this help

Exit codes:
  0  --help, or guard stopped: it was signalled, or it gave up
  2  wrong usage: this help goes to stderr and nothing starts
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

if [ $# -lt 2 ] || [[ "$1" == -* ]]; then
  usage >&2
  exit 2
fi

NAME="$1"
shift

LOG_WRITER="/usr/local/bin/log-writer"
MAX_RESTARTS=50
INITIAL_DELAY=2
MAX_DELAY=60
STABLE_THRESHOLD=30

guard_log() {
  echo "$1"
  "$LOG_WRITER" --name "$NAME" --line "$1" 2>/dev/null || true
}

guard_event() {
  "$LOG_WRITER" --name "$NAME" --event "$1" \
    ${2:+--exit-code "$2"} \
    ${3:+--uptime "$3"} \
    ${4:+--restart "$4"} 2>/dev/null || true
}

SHOULD_EXIT=false
trap 'SHOULD_EXIT=true' TERM INT

restart_count=0
quick_restarts=0
delay=$INITIAL_DELAY

while true; do
  guard_log "[guard:$NAME] Starting: $* (restart #$restart_count)"
  guard_event "started" "" "" "$restart_count"
  start_time=$SECONDS

  "$@" 2>&1 | "$LOG_WRITER" --name "$NAME"
  EXIT_CODE=${PIPESTATUS[0]}

  elapsed=$(( SECONDS - start_time ))

  if $SHOULD_EXIT; then
    guard_log "[guard:$NAME] Received signal, stopping after ${elapsed}s"
    guard_event "signal" "" "$elapsed" "$restart_count"
    break
  fi

  restart_count=$((restart_count + 1))

  if [ $elapsed -ge $STABLE_THRESHOLD ]; then
    delay=$INITIAL_DELAY
    quick_restarts=0
  else
    quick_restarts=$((quick_restarts + 1))
  fi

  if [ $quick_restarts -ge $MAX_RESTARTS ]; then
    guard_log "[guard:$NAME] Exited with code $EXIT_CODE after ${elapsed}s. Giving up after $MAX_RESTARTS restarts in a row that each ran under ${STABLE_THRESHOLD}s."
    guard_event "crashed" "$EXIT_CODE" "$elapsed" "$restart_count"
    guard_event "gave_up" "$EXIT_CODE" "$elapsed" "$restart_count"
    break
  fi

  if [ $EXIT_CODE -eq 0 ]; then
    guard_log "[guard:$NAME] Exited cleanly after ${elapsed}s, restarting in ${delay}s... ($quick_restarts/$MAX_RESTARTS)"
    guard_event "stopped" "0" "$elapsed" "$restart_count"
  else
    guard_log "[guard:$NAME] Crashed with exit code $EXIT_CODE after ${elapsed}s, restarting in ${delay}s... ($quick_restarts/$MAX_RESTARTS)"
    guard_event "crashed" "$EXIT_CODE" "$elapsed" "$restart_count"
  fi
  sleep $delay

  if [ $delay -lt $MAX_DELAY ]; then
    delay=$((delay * 2))
    if [ $delay -gt $MAX_DELAY ]; then
      delay=$MAX_DELAY
    fi
  fi
done
