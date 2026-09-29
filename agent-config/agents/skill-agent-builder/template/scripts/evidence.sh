#!/bin/sh
# The child's record since one of your prompts: every command it ran, with its exit code and output,
# every question it asked you, with its options and the answer it got, and the screenshots it saved.
#
#   sh scripts/evidence.sh "$BASE" "$SES" msg_1727300000
#
# The third argument is the id you sent with the prompt. Entries come oldest first. Each command
# output keeps its last $EVIDENCE_LINES lines (default 60). A question reads `question (open)` until
# its Form is answered, `question (answered)` with the answer after `=`, and `question (dismissed)`
# when it was cancelled. Screenshots in the child's /workspace/.cache/checks/ are copied into
# scratch/shots/ as child-<name>.
set -eu

base=${1:?usage: evidence.sh <baseUrl> <sessionId> <messageId>}
session=${2:?usage: evidence.sh <baseUrl> <sessionId> <messageId>}
since=${3:?usage: evidence.sh <baseUrl> <sessionId> <messageId>}
lines=${EVIDENCE_LINES:-60}
api="sh $(dirname "$0")/api.sh"
shots=scratch/shots
pages=$(mktemp -d "${TMPDIR:-/tmp}/evidence.XXXXXX")
trap 'rm -rf "$pages"' EXIT

query="limit=200&order=desc"
page=0
while :; do
  page=$((page + 1))
  current=$(printf '%s/page-%04d.json' "$pages" "$page")
  $api runtime "$base" GET "/api/session/$session/message?$query" > "$current"
  jq -e '.data | type == "array"' "$current" > /dev/null || {
    echo "evidence: the runtime did not return messages:" >&2
    head -c 500 "$current" >&2
    exit 1
  }
  jq -e --arg id "$since" 'any(.data[]; .id == $id)' "$current" > /dev/null && break
  next=$(jq -r '.cursor.next // empty' "$current")
  [ -n "$next" ] || { echo "evidence: no message $since in session $session" >&2; exit 1; }
  query="limit=200&cursor=$(jq -rn --arg c "$next" '$c | @uri')"
done

jq -s -r --arg id "$since" --argjson lines "$lines" '
  def command_entry($s):
    ($s.metadata.exit // $s.metadata.exitCode // (if $s.status == "error" then "error" else $s.status end)) as $exit
    | ([$s.content[]? | select(.type == "text") | .text] | join("\n")
       | if . == "" then ($s.output // "") else . end
       | split("\n")) as $out
    | "exit \($exit)\n$ \($s.input.command)\n"
      + (if ($out | length) > $lines then "… \(($out | length) - $lines) earlier lines cut\n" else "" end)
      + ($out[-$lines:] | join("\n"));
  def question_entry($s):
    ({running: "open", completed: "answered", error: "dismissed"}[$s.status] // $s.status) as $state
    | "question (\($state))\n"
      + ([($s.input | objects | .questions) // [] | to_entries[]
          | .key as $i | .value as $q
          | "? \($q.question)  [\([$q.options[]?.label] | join(" | "))]"
            + (($s.metadata.answers // [])[$i] as $a
               | if $a == null then "" else "\n= \(if ($a | length) == 0 then "(no answer)" else ($a | join(", ")) end)" end)]
         | join("\n"));
  [.[].data[]] | reverse
  | (map(.id) | index($id)) as $at
  | .[$at + 1:]
  | [.[] | select(.type == "assistant") | .content[]?
      | select(.type == "tool")
      | select(((.name == "shell" or .name == "bash") and .state.input.command? != null) or .name == "question")]
  | if length == 0 then "No commands recorded since \($id)."
    else to_entries | map(
      "## \(.key + 1). "
      + (if .value.name == "question" then question_entry(.value.state) else command_entry(.value.state) end)
    ) | join("\n\n")
    end
' "$pages"/page-*.json

$api runtime "$base" GET "/api/fs/list?path=/workspace/.cache/checks" > "$pages/checks.json" 2>/dev/null || true
if jq -e '.data | type == "array"' "$pages/checks.json" > /dev/null 2>&1; then
  mkdir -p "$shots"
  copied=0
  jq -r '.data[] | select(.type == "file") | .path' "$pages/checks.json" > "$pages/checks.txt"
  while IFS= read -r file; do
    encoded=$(jq -rn --arg p "$file" '$p | split("/") | map(@uri) | join("/")')
    $api runtime "$base" GET "/api/fs/read/$encoded" > "$shots/child-$(basename "$file")"
    copied=$((copied + 1))
  done < "$pages/checks.txt"
  printf '\nScreenshots: %s copied into %s/ as child-<name>.\n' "$copied" "$shots"
else
  printf '\nScreenshots: none in /workspace/.cache/checks/.\n'
fi
