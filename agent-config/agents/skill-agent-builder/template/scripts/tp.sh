#!/bin/sh
# The chat's one Test Project, from the workspace root. State lives in scratch/test-project.json
# (projectId, agentId, environmentId, baseUrl, sessionId, lastMessageId), so every call picks up
# where the last one stopped, in a new shell or a resumed chat alike.
#
#   sh scripts/tp.sh up                  # find it (state, GET /me, a 409) or create it; wait; connect
#   sh scripts/tp.sh prompt '<text>'     # send it under a fresh msg_ id, then wait as `turn` does
#   sh scripts/tp.sh turn                # wait for the child's turn: turn.sh's exit codes
#   sh scripts/tp.sh interrupt           # stop the child's turn: for a genuine stall only
#   sh scripts/tp.sh answer '<json>'     # reply {"<field key>":<value>} to the open Form, then wait
#   sh scripts/tp.sh evidence            # evidence.sh since the last prompt
#   sh scripts/tp.sh sh '<command>'      # run it in the Test Project, session-free; its output and exit code
#   sh scripts/tp.sh app-url             # http://<pod ip>:<APP_PORT>, reachable from this pod
#   sh scripts/tp.sh touched             # before the save: files both the child and the save change
#   sh scripts/tp.sh restart | update | reset
#
# Exit 1 carries its reason on the last line; `disabled:` means someone switched the Project off.
# `up` retries a `failed` environment once through a restart. Waits poll every $TP_POLL seconds
# (default 5), $TP_ATTEMPTS times (default 36). `touched` takes the save's changes from
# template-snapshot.sh diff, so run it after the check and before the save.
set -eu

here=$(dirname "$0")
state=scratch/test-project.json
poll=${TP_POLL:-5}
attempts=${TP_ATTEMPTS:-36}
export API_MAX_TIME="${API_MAX_TIME:-60}"

api() { sh "$here/api.sh" "$@"; }
die() { echo "$*" >&2; exit 1; }

get() { jq -r --arg k "$1" '.[$k] // empty' "$state" 2>/dev/null || true; }

put() {
  mkdir -p "$(dirname "$state")"
  [ -s "$state" ] || echo '{}' > "$state"
  next=$(jq --arg k "$1" --arg v "$2" 'if $v == "" then del(.[$k]) else .[$k] = $v end' "$state")
  printf '%s\n' "$next" > "$state"
}

need() {
  value=$(get "$1")
  [ -n "$value" ] || die "no $1 in $state: run 'sh scripts/tp.sh up' first"
  printf '%s' "$value"
}

refused() {
  [ -z "$1" ] && return 1
  printf '%s\n' "$1" | head -c 800 >&2
  echo >&2
  return 0
}

accepted() {
  [ "$1" -eq 0 ] || die "$2 did not answer"
  refused "$3" && die "$2 was refused"
  return 0
}

rename_legacy() {
  for kind in expectations prompt; do
    [ -e "scratch/$kind.md" ] && continue
    set -- scratch/*."$kind".md
    [ $# -eq 1 ] && [ -e "$1" ] || continue
    mv "$1" "scratch/$kind.md"
    echo "renamed $1 to scratch/$kind.md"
  done
}

wait_active() {
  project=$1
  i=0
  status=unknown
  while [ "$i" -lt "$attempts" ]; do
    i=$((i + 1))
    body=$(api call GET "/projects/$project")
    if [ "$(printf '%s' "$body" | jq -r '.disabled // false')" = true ]; then
      echo "disabled: Test Project $project is switched off; it comes back from the Test run pane's menu beside this chat"
      return 1
    fi
    status=$(printf '%s' "$body" | jq -r '.environments[0].status // "unknown"')
    [ "$status" = active ] && return 0
    [ "$status" = failed ] && return 7
    sleep "$poll"
  done
  echo "still $status after $((attempts * poll)) s"
  return 1
}

connect() {
  project=$1
  environment=$(api call GET "/projects/$project" | jq -r '.environments[0].id // empty')
  [ -n "$environment" ] || die "Test Project $project reports no environment"
  i=0
  while :; do
    i=$((i + 1))
    connection=$(api call POST "/projects/$project/environments/$environment/connect")
    base=$(printf '%s' "$connection" | jq -r '.baseUrl // empty' 2>/dev/null || true)
    [ -n "$base" ] && break
    [ "$i" -lt "$attempts" ] || { refused "$connection" || true; die "connect kept refusing"; }
    sleep "$poll"
  done
  session=$(printf '%s' "$connection" | jq -r .sessionId)
  put environmentId "$environment"
  put baseUrl "$base"
  put sessionId "$session"
  echo "project $project"
  echo "environment $environment active"
  echo "session $session"
  echo "base $base"
  echo "openapi $(printf '%s' "$connection" | jq -r '.openapiUrl // empty')"
}

ready() {
  project=$1
  set +e
  wait_active "$project"
  waited=$?
  set -e
  if [ "$waited" -eq 7 ]; then
    echo "environment failed: restarting it once"
    out=$(api call POST "/projects/$project/restart") && sent=0 || sent=$?
    accepted "$sent" restart "$out"
    set +e
    wait_active "$project"
    waited=$?
    set -e
    [ "$waited" -eq 7 ] && die "environment failed twice: a pod fault, most likely node capacity, never the Template"
  fi
  [ "$waited" -eq 0 ] || exit 1
  connect "$project"
}

up() {
  rename_legacy
  project=$(get projectId)
  if [ -n "$project" ]; then
    code=$(api status GET "/projects/$project")
    case "$code" in
      200) ;;
      404) echo "Test Project $project is gone"; project=""; printf '{}\n' > "$state" ;;
      *) die "GET /projects/$project answered $code" ;;
    esac
  fi
  if [ -z "$project" ]; then
    me=$(api call GET /me)
    type=$(printf '%s' "$me" | jq -r '.builderSubject.type // empty')
    [ "$type" = agent ] || die "this chat authors a ${type:-subject nobody named}; a Test Project runs an Agent"
    agent=$(printf '%s' "$me" | jq -r .builderSubject.id)
    project=$(printf '%s' "$me" | jq -r '.builderTestProject.id // empty')
    if [ -z "$project" ]; then
      created=$(api call POST /projects "$(jq -cn --arg a "$agent" '{agentId: $a, title: "Test run", kind: "test"}')")
      project=$(printf '%s' "$created" | jq -r '.id // .testProjectId // empty' 2>/dev/null || true)
      [ -n "$project" ] || { refused "$created" || true; die "the create was refused"; }
    fi
    printf '{}\n' > "$state"
    put projectId "$project"
    put agentId "$agent"
    put createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  ready "$project"
}

refresh() {
  kind=$1
  project=$(need projectId)
  case "$kind" in
    restart) out=$(api call POST "/projects/$project/restart") && sent=0 || sent=$? ;;
    update) out=$(api call POST "/projects/$project/test/update") && sent=0 || sent=$? ;;
    reset) out=$(api call POST "/projects/$project/test/reset") && sent=0 || sent=$? ;;
  esac
  accepted "$sent" "$kind" "$out"
  case "$kind" in
    update) echo "updated: the saved Template is laid over the workspace and committed as \"Template update\"" ;;
    reset) put sessionId ""; put lastMessageId ""; echo "reset: the workspace is laid again; a new Session follows"; ready "$project" ;;
    restart) ready "$project" ;;
  esac
}

turn() {
  base=$(need baseUrl)
  session=$(need sessionId)
  exec sh "$here/turn.sh" "$base" "$session"
}

prompt() {
  text=${1:?usage: tp.sh prompt '<text>'}
  base=$(need baseUrl)
  session=$(need sessionId)
  message=msg_$(date +%s)
  [ "$message" = "$(get lastMessageId)" ] && { sleep 1; message=msg_$(date +%s); }
  put lastMessageId "$message"
  answer=$(api runtime "$base" POST "/api/session/$session/prompt" "$(jq -cn --arg id "$message" --arg t "$text" '{id: $id, text: $t}')")
  if printf '%s' "$answer" | jq -e 'type == "object" and ((.name // "") | test("Error$"))' > /dev/null 2>&1; then
    refused "$answer" || true
    die "the prompt was refused"
  fi
  echo "sent $message"
  turn
}

answer() {
  reply=${1:?usage: tp.sh answer '{"<field key>":<value>}'}
  printf '%s' "$reply" | jq -e 'type == "object"' > /dev/null 2>&1 || die "the answer must be a JSON object keyed by field"
  base=$(need baseUrl)
  session=$(need sessionId)
  form=${2:-$(api runtime "$base" GET "/api/session/$session/form" | jq -r '.data[0].id // empty')}
  [ -n "$form" ] || die "no open Form in session $session"
  refused "$(api runtime "$base" POST "/api/session/$session/form/$form/reply" "$(jq -cn --argjson a "$reply" '{answer: $a}')")" \
    && die "the reply to $form was refused"
  echo "answered $form"
  turn
}

interrupt() {
  base=$(need baseUrl)
  session=$(need sessionId)
  api runtime "$base" POST "/api/session/$session/interrupt"
  echo
}

evidence() {
  base=$(need baseUrl)
  session=$(need sessionId)
  since=$(need lastMessageId)
  exec sh "$here/evidence.sh" "$base" "$session" "$since"
}

run() {
  command=${1:?usage: tp.sh sh '<command>'}
  base=$(need baseUrl)
  shell=$(api runtime "$base" POST /api/shell "$(jq -cn --arg c "$command" '{command: $c, timeout: 60000}')" | jq -r '.data.id // empty')
  [ -n "$shell" ] || die "the runtime refused the shell command"
  i=0
  status=running
  while [ "$i" -lt 45 ]; do
    i=$((i + 1))
    info=$(api runtime "$base" GET "/api/shell/$shell")
    status=$(printf '%s' "$info" | jq -r '.data.status // "unknown"')
    [ "$status" != running ] && break
    sleep 2
  done
  cursor=0
  pages=0
  while [ "$pages" -lt 200 ]; do
    pages=$((pages + 1))
    page=$(api runtime "$base" GET "/api/shell/$shell/output?cursor=$cursor")
    printf '%s' "$page" | jq -j '.data.output // ""'
    next=$(printf '%s' "$page" | jq -r '.data.cursor // empty')
    { [ -z "$next" ] || [ "$next" -le "$cursor" ]; } && break
    cursor=$next
    [ "$cursor" -ge "$(printf '%s' "$page" | jq -r '.data.size // 0')" ] && break
  done
  [ "$status" = running ] && die "the command still runs after 90 s: the runtime itself is gone"
  code=$(printf '%s' "$info" | jq -r '.data.exit // empty | floor')
  return "${code:-1}"
}

app_url() {
  address=$(run 'hostname -i' | awk '{print $1; exit}')
  port=$(run 'printf %s "$APP_PORT"')
  [ -n "$address" ] && [ -n "$port" ] || die "the Test Project reports no address or no APP_PORT"
  echo "http://$address:$port"
}

touched() {
  need baseUrl > /dev/null
  work=$(mktemp -d "${TMPDIR:-/tmp}/touched.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  run 'cd /workspace && { git diff --name-only "$(git log -1 --format=%H --grep="^Initial template$" --grep="^Template update$")"; git ls-files -o --exclude-standard; } | sort -u' \
    | sort -u > "$work/child"
  if [ -d .cache/template-saved ]; then
    sh "$here/template-snapshot.sh" diff > "$work/diff" || true
    sed -n 's/^[AMD] //p' "$work/diff" | sort -u > "$work/save"
    sed -n 's/^D //p' "$work/diff" > "$work/dropped"
  else
    echo "no snapshot of the last save: every file in template/ counts as changed"
    { [ -d template ] && (cd template && find . -type f -o -type l) | sed 's#^\./##'; } | sort -u > "$work/save"
    : > "$work/dropped"
  fi
  comm -12 "$work/child" "$work/save" > "$work/both"
  if [ -s "$work/both" ]; then sed 's/^/touched /' "$work/both"; else echo untouched; fi
  sed 's/$/: an update keeps it, so remove it through tp.sh sh/; s/^/dropped /' "$work/dropped"
}

command=${1:-}
[ $# -gt 0 ] && shift
case "$command" in
  up) up ;;
  prompt) prompt "$@" ;;
  turn) turn ;;
  interrupt) interrupt ;;
  answer) answer "$@" ;;
  evidence) evidence ;;
  sh) run "$@" ;;
  app-url) app_url ;;
  touched) touched ;;
  restart | update | reset) refresh "$command" ;;
  *) echo "usage: tp.sh up|prompt|turn|interrupt|answer|evidence|sh|app-url|touched|restart|update|reset" >&2; exit 2 ;;
esac
