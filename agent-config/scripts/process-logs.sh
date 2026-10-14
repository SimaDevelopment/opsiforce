#!/bin/bash
# Reads the process logs the platform's log-writer keeps under /workspace/data/logs.
# Usage: process-logs [--since 2m] [--grep REGEX] [--events] [--lines N] [--list] [--follow] [process...]

set -euo pipefail

LOG_DIR="${PROCESS_LOG_DIR:-/workspace/data/logs}"
SINCE=""
PATTERN=""
EVENTS_ONLY=false
LIMIT=200
MODE=read
NAMES=()

usage() {
  cat <<'EOF'
process-logs — read the output and lifecycle events of every supervised process.

  process-logs [options] [process...]

  -s, --since DURATION  only lines newer than DURATION: 90s, 2m, 1h, 3d
  -g, --grep REGEX      only lines matching REGEX (extended, case-insensitive)
  -e, --events          only lifecycle events (started, crashed, stopped, signal, gave_up)
  -n, --lines N         print the last N matching lines (default 200, 0 = all)
  -l, --list            list processes with their last write and size
  -f, --follow          stream new lines as they are written
  -h, --help            this help

With no process named, every process is read. When more than one process is read, each line names its process.
Lines read "<UTC timestamp> [<process>] <line>"; events read "... [event] crashed exit_code=1 uptime_seconds=3 restart_count=2".
EOF
}

fail() {
  echo "process-logs: $1" >&2
  usage >&2
  exit 2
}

value_of() {
  [ $# -ge 2 ] || fail "$1 needs a value"
  echo "$2"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -s|--since) SINCE=$(value_of "$@"); shift 2 ;;
    -g|--grep) PATTERN=$(value_of "$@"); shift 2 ;;
    -e|--events) EVENTS_ONLY=true; shift ;;
    -n|--lines) LIMIT=$(value_of "$@"); shift 2 ;;
    -l|--list) MODE=list; shift ;;
    -f|--follow) MODE=follow; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; NAMES+=("$@"); break ;;
    -*) fail "unknown option $1" ;;
    *) NAMES+=("$1"); shift ;;
  esac
done

[[ "$LIMIT" =~ ^[0-9]+$ ]] || fail "--lines takes a whole number"

if [ ! -d "$LOG_DIR" ]; then
  echo "process-logs: no logs yet ($LOG_DIR does not exist)" >&2
  exit 0
fi

all_names() {
  local file name
  for file in "$LOG_DIR"/*.log "$LOG_DIR"/*.log.*; do
    [ -e "$file" ] || continue
    name="${file##*/}"
    if [[ "$name" == *.log ]]; then
      echo "${name%.log}"
    else
      echo "${name%.log.*}"
    fi
  done | sort -u
}

for index in "${!NAMES[@]}"; do
  NAMES[$index]="${NAMES[$index]//[^A-Za-z0-9._-]/_}"
done

if [ ${#NAMES[@]} -eq 0 ]; then
  while IFS= read -r name; do NAMES+=("$name"); done < <(all_names)
fi
if [ ${#NAMES[@]} -eq 0 ]; then
  echo "process-logs: no logs yet in $LOG_DIR" >&2
  exit 0
fi

files_oldest_first() {
  local name="$1" file suffix
  local -a numbered=()
  for file in "$LOG_DIR/$name.log".*; do
    [ -e "$file" ] || continue
    suffix="${file##*.log.}"
    if [[ "$suffix" =~ ^[0-9]+$ ]]; then
      numbered+=("$suffix")
    else
      echo "$file"
    fi
  done
  if [ ${#numbered[@]} -gt 0 ]; then
    printf '%s\n' "${numbered[@]}" | sort -rn | while IFS= read -r suffix; do
      echo "$LOG_DIR/$name.log.$suffix"
    done
  fi
  [ -e "$LOG_DIR/$name.log" ] && echo "$LOG_DIR/$name.log"
  return 0
}

epoch_to_timestamp() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z
}

cutoff_timestamp() {
  local amount unit seconds
  if [[ ! "$1" =~ ^([0-9]+)([smhd]?)$ ]]; then
    echo "process-logs: --since takes a number with s, m, h or d, e.g. 2m" >&2
    exit 2
  fi
  amount="${BASH_REMATCH[1]}"
  unit="${BASH_REMATCH[2]:-s}"
  case "$unit" in
    s) seconds=$amount ;;
    m) seconds=$((amount * 60)) ;;
    h) seconds=$((amount * 3600)) ;;
    d) seconds=$((amount * 86400)) ;;
  esac
  epoch_to_timestamp $(( $(date +%s) - seconds ))
}

if [ "$MODE" = list ]; then
  printf '%-24s %-24s %10s\n' PROCESS LAST_WRITE BYTES
  for name in "${NAMES[@]}"; do
    total=0
    last=""
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      total=$((total + $(wc -c < "$file")))
      last=$(tail -n 1 "$file" | cut -d' ' -f1)
    done < <(files_oldest_first "$name")
    printf '%-24s %-24s %10s\n' "$name" "${last:--}" "$total"
  done
  exit 0
fi

CUTOFF=""
[ -n "$SINCE" ] && CUTOFF=$(cutoff_timestamp "$SINCE")
PREFIX=false
[ ${#NAMES[@]} -gt 1 ] && PREFIX=true

filter() {
  awk -v name="$1" -v cutoff="$CUTOFF" -v events="$EVENTS_ONLY" -v prefix="$PREFIX" '
    {
      if (cutoff != "" && $1 < cutoff) next
      if (events == "true" && $2 != "[event]") next
      if (prefix == "true") {
        print $1 " [" name "] " substr($0, length($1) + 2)
      } else {
        print
      }
      fflush()
    }' | if [ -n "$PATTERN" ]; then grep --line-buffered -iE -- "$PATTERN" || true; else cat; fi
}

if [ "$MODE" = follow ]; then
  for name in "${NAMES[@]}"; do
    tail -n 0 -F "$LOG_DIR/$name.log" 2>/dev/null | filter "$name" &
  done
  trap 'kill 0' INT TERM
  wait
  exit 0
fi

for name in "${NAMES[@]}"; do
  while IFS= read -r file; do
    [ -n "$file" ] && filter "$name" < "$file"
  done < <(files_oldest_first "$name")
done | sort -s -k1,1 | if [ "$LIMIT" -gt 0 ]; then tail -n "$LIMIT"; else cat; fi
