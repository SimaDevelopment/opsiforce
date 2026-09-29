#!/bin/sh
# Thin curl wrappers around the two endpoints this pod is allowed to call. Not a CLI: read it, and
# reach for plain curl whenever a call needs a header or a flag it does not pass.
#
#   sh scripts/api.sh call GET  /me
#   sh scripts/api.sh call GET  '/skills?filter=built_in'
#   sh scripts/api.sh call POST /skills @scratch/body.json
#   sh scripts/api.sh runtime /api/proxy/<envId> POST /api/session/<ses>/prompt '{"text":"hello"}'
#   sh scripts/api.sh status GET /me                      # print the HTTP status only
#
# `call` talks to the platform API at $OPSIFORCE_API_URL; `runtime` talks to a Test Project's opencode
# runtime through the runtime proxy at $OPSIFORCE_RUNTIME_PROXY_URL, whose baseUrl a Connection
# reports. The two are different Services, so the runtime origin is its own variable. Both send
# $OPSIFORCE_API_KEY, which is this pod's platform-api key: it acts as the human who created this
# chat and reaches only Projects this pod created. $API_MAX_TIME, when set, bounds each request in
# seconds.
set -eu

: "${OPSIFORCE_API_URL:?OPSIFORCE_API_URL is not set — this pod holds no platform-api key}"
: "${OPSIFORCE_API_KEY:?OPSIFORCE_API_KEY is not set — this pod holds no platform-api key}"

# A Connection's baseUrl is origin-relative (/api/proxy/<envId>) and the runtime proxy is a
# different Service from the platform API, so it carries its own origin.
origin() {
  printf '%s' "${OPSIFORCE_RUNTIME_PROXY_URL:?OPSIFORCE_RUNTIME_PROXY_URL is not set}" | sed 's#/*$##'
}

request() {
  url=$1
  method=$2
  body=${3-}
  set -- ${API_MAX_TIME:+--max-time "$API_MAX_TIME"}
  if [ -n "$body" ]; then
    case "$body" in
      @*) curl -sS "$@" -X "$method" "$url" -H "Authorization: Bearer $OPSIFORCE_API_KEY" \
            -H 'Content-Type: application/json' --data-binary "$body" ;;
      *) curl -sS "$@" -X "$method" "$url" -H "Authorization: Bearer $OPSIFORCE_API_KEY" \
            -H 'Content-Type: application/json' --data-raw "$body" ;;
    esac
  else
    curl -sS "$@" -X "$method" "$url" -H "Authorization: Bearer $OPSIFORCE_API_KEY"
  fi
}

command=${1:?usage: api.sh call|runtime|status ...}
shift

case "$command" in
  call)
    method=${1:?method}; path=${2:?path}; shift 2
    request "$OPSIFORCE_API_URL$path" "$method" "${1-}"
    ;;
  runtime)
    base=${1:?baseUrl}; method=${2:?method}; path=${3:?path}; shift 3
    request "$(origin)$base$path" "$method" "${1-}"
    ;;
  status)
    method=${1:?method}; path=${2:?path}; shift 2
    curl -sS -o /dev/null -w '%{http_code}\n' -X "$method" "$OPSIFORCE_API_URL$path" \
      -H "Authorization: Bearer $OPSIFORCE_API_KEY"
    ;;
  origin)
    origin
    ;;
  *)
    echo "unknown command: $command (call|runtime|status|origin)" >&2
    exit 2
    ;;
esac
