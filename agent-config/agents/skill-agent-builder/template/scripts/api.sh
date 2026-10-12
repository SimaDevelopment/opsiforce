#!/bin/sh
# Thin curl wrappers for the two things this pod calls. Not a CLI: read it, and reach for plain curl
# whenever a call needs a header or a flag it does not pass.
#
#   sh scripts/api.sh call get_me
#   sh scripts/api.sh call list_skills '{"filter":"built_in"}'
#   sh scripts/api.sh call create_skill @scratch/body.json
#   sh scripts/api.sh status get_project '{"id":"<projectId>"}'       # print the HTTP status only
#   sh scripts/api.sh runtime /api/proxy/<envId> POST /api/session/<ses>/prompt '{"text":"hello"}'
#
# `call` is callService for the `public-api` External Service: it POSTs one Operation with its input
# to $EXTERNAL_SERVICES_URL/public-api/<operation> and waits out a 503 that names a Retry-After, up to
# three times. `runtime` talks to a Test Project's opencode runtime through the runtime proxy at
# $OPSIFORCE_RUNTIME_PROXY_URL, whose baseUrl a Connection reports. Both send $SERVICE_GATEWAY_API_KEY,
# this pod's one key: the Gate acts as the human who created this chat and reaches only Projects this
# chat created. $API_MAX_TIME, when set, bounds each request in seconds.
set -eu

: "${EXTERNAL_SERVICES_URL:?EXTERNAL_SERVICES_URL is not set}"
: "${SERVICE_GATEWAY_API_KEY:?SERVICE_GATEWAY_API_KEY is not set}"

trimmed() {
  printf '%s' "$1" | sed 's#/*$##'
}

origin() {
  trimmed "${OPSIFORCE_RUNTIME_PROXY_URL:?OPSIFORCE_RUNTIME_PROXY_URL is not set}"
}

post_operation() {
  operation=$1
  input=$2
  answer=$3
  headers=$4
  set -- ${API_MAX_TIME:+--max-time "$API_MAX_TIME"}
  case "$input" in
    @*) set -- "$@" --data-binary "$input" ;;
    *) set -- "$@" --data-raw "$input" ;;
  esac
  curl -sS "$@" -o "$answer" -D "$headers" -w '%{http_code}' -X POST \
    "$(trimmed "$EXTERNAL_SERVICES_URL")/public-api/$operation" \
    -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" -H 'Content-Type: application/json'
}

call_service() {
  operation=${1:?operation}
  input=${2:-'{}'}
  answer=$(mktemp)
  headers=$(mktemp)
  attempt=1
  while :; do
    code=$(post_operation "$operation" "$input" "$answer" "$headers")
    wait=$(tr -d '\r' < "$headers" | awk -F': *' 'tolower($1) == "retry-after" { print $2 }' | tail -n 1)
    if [ "$code" = 503 ] && [ -n "$wait" ] && [ "$attempt" -lt 4 ]; then
      attempt=$((attempt + 1))
      sleep "$wait"
      continue
    fi
    break
  done
  CALL_STATUS=$code
  cat "$answer"
  rm -f "$answer" "$headers"
}

runtime() {
  url=$1
  method=$2
  body=${3-}
  set -- ${API_MAX_TIME:+--max-time "$API_MAX_TIME"}
  if [ -n "$body" ]; then
    case "$body" in
      @*) curl -sS "$@" -X "$method" "$url" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" \
            -H 'Content-Type: application/json' --data-binary "$body" ;;
      *) curl -sS "$@" -X "$method" "$url" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" \
            -H 'Content-Type: application/json' --data-raw "$body" ;;
    esac
  else
    curl -sS "$@" -X "$method" "$url" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
  fi
}

command=${1:?usage: api.sh call|status|runtime|origin ...}
shift

case "$command" in
  call)
    call_service "$@"
    ;;
  status)
    call_service "$@" > /dev/null
    echo "$CALL_STATUS"
    ;;
  runtime)
    base=${1:?baseUrl}; method=${2:?method}; path=${3:?path}; shift 3
    runtime "$(origin)$base$path" "$method" "${1-}"
    ;;
  origin)
    origin
    ;;
  *)
    echo "unknown command: $command (call|status|runtime|origin)" >&2
    exit 2
    ;;
esac
