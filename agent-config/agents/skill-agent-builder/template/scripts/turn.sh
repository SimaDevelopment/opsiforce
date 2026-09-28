#!/bin/sh
# Wait for the child's turn, with a deadline. Use it instead of the runtime's own `wait`, which has
# none and never returns while a Form holds the turn.
#
#   sh scripts/turn.sh "$BASE" "$SES"
#
# Exit 0: the Session is idle and the child's last turn finished (`idle finish=stop`). Exit 5: idle,
# but the turn broke off (`idle finish=<error|tool-calls|…>`, with the error when there is one). Exit 3:
# an open Form holds the turn; it is printed, answer it and run this again. Exit 4: still running at the
# deadline, $TURN_TIMEOUT seconds (default 900). Exit 1: the runtime has no such Session. Polls every
# $TURN_POLL seconds (default 5).
set -eu

base=${1:?usage: turn.sh <baseUrl> <sessionId>}
session=${2:?usage: turn.sh <baseUrl> <sessionId>}
timeout=${TURN_TIMEOUT:-900}
poll=${TURN_POLL:-5}
api="sh $(dirname "$0")/api.sh"
export API_MAX_TIME="${API_MAX_TIME:-30}"

found=$($api runtime "$base" GET "/api/session/$session" 2>&1 || true)
printf '%s' "$found" | jq -e --arg id "$session" '.data.id == $id' > /dev/null 2>&1 || {
  echo "turn: the runtime has no session $session:" >&2
  printf '%s\n' "$found" | head -c 500 >&2
  exit 1
}

finished() {
  last=$($api runtime "$base" GET "/api/session/$session/message?limit=20&order=desc" 2>/dev/null || true)
  finish=$(printf '%s' "$last" | jq -r '[.data[]? | select(.type == "assistant")][0].finish // "none"' 2>/dev/null || echo none)
  echo "idle finish=$finish"
  [ "$finish" = stop ] && exit 0
  printf '%s' "$last" | jq -r '[.data[]? | select(.type == "assistant")][0].error // empty
    | "error: \(.message // .data.message // tojson)"' 2>/dev/null | head -c 500 || true
  exit 5
}

start=$(date +%s)
while :; do
  active=$($api runtime "$base" GET /api/session/active 2>/dev/null || true)
  if printf '%s' "$active" | jq -e '.data | type == "object"' > /dev/null 2>&1; then
    printf '%s' "$active" | jq -e --arg id "$session" '.data | has($id)' > /dev/null || finished
    forms=$($api runtime "$base" GET "/api/session/$session/form" 2>/dev/null || true)
    if printf '%s' "$forms" | jq -e '.data | type == "array" and length > 0' > /dev/null 2>&1; then
      printf '%s' "$forms" | jq -r '.data[] | "form \(.id): \(.title)"'
      printf '%s' "$forms" | jq '[.data[] | {id, fields: [.fields[] | {key, type, title, description, required, options: ([.options[]? | .value]), custom}
        | with_entries(select(.value != null))]}]'
      exit 3
    fi
  fi
  elapsed=$(($(date +%s) - start))
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "timeout: the turn is still running after ${elapsed} s"
    exit 4
  fi
  sleep "$poll"
done
