#!/bin/sh
# Thin curl wrappers for the two things this pod calls. Not a CLI: read it, and reach for plain curl
# whenever a call needs a header or a flag it does not pass.
#
#   sh scripts/api.sh GET /me
#   sh scripts/api.sh GET '/skills?filter=built_in'
#   sh scripts/api.sh POST /skills @scratch/body.json
#   sh scripts/api.sh status GET /projects/<projectId>                 # print the HTTP status only
#   sh scripts/api.sh runtime /api/proxy/<envId> POST /api/session/<ses>/prompt '{"text":"hello"}'
#
# `<METHOD> <path> [json]` calls the Opsiforce Public API on its Service host,
# https://public-api.$EXTERNAL_SERVICES_HOST/api/v1<path> (docs at /api/v1/docs on the main host), and waits out a 503
# that names a Retry-After, up to three times. `runtime` talks to a Test Project's opencode runtime
# through the runtime proxy at $OPSIFORCE_RUNTIME_PROXY_URL, whose baseUrl a Connection reports. Both
# send $SERVICE_GATEWAY_API_KEY, this pod's one key: the API acts as the human who created this chat
# and reaches only Projects this chat created. $API_MAX_TIME, when set, bounds each request in seconds.
set -eu

: "${SERVICE_GATEWAY_API_KEY:?SERVICE_GATEWAY_API_KEY is not set}"

trimmed() {
  printf '%s' "$1" | sed 's#/*$##'
}

api_base() {
  if [ -n "${PUBLIC_API_URL:-}" ]; then
    trimmed "$PUBLIC_API_URL"
  else
    echo "https://public-api.${EXTERNAL_SERVICES_HOST:?EXTERNAL_SERVICES_HOST is not set}/api/v1"
  fi
}

origin() {
  trimmed "${OPSIFORCE_RUNTIME_PROXY_URL:?OPSIFORCE_RUNTIME_PROXY_URL is not set}"
}

send() {
  method=$1
  path=$2
  body=$3
  answer=$4
  headers=$5
  set -- ${API_MAX_TIME:+--max-time "$API_MAX_TIME"}
  case "$body" in
    '') ;;
    @*) set -- "$@" -H 'Content-Type: application/json' --data-binary "$body" ;;
    *) set -- "$@" -H 'Content-Type: application/json' --data-raw "$body" ;;
  esac
  curl -sS "$@" -o "$answer" -D "$headers" -w '%{http_code}' -X "$method" \
    "$(api_base)$path" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
}

call_api() {
  method=${1:?method}
  path=${2:?path}
  body=${3-}
  answer=$(mktemp)
  headers=$(mktemp)
  attempt=1
  while :; do
    code=$(send "$method" "$path" "$body" "$answer" "$headers")
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

command=${1:?usage: api.sh <METHOD> <path> [json] | status <METHOD> <path> [json] | runtime ... | origin}
shift

case "$command" in
  GET|POST|PUT|PATCH|DELETE)
    call_api "$command" "$@"
    ;;
  status)
    call_api "$@" > /dev/null
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
    echo "unknown command: $command (GET|POST|PUT|PATCH|DELETE|status|runtime|origin)" >&2
    exit 2
    ;;
esac
