# The test loop, exactly

Every platform call is relative to `$OPSIFORCE_API_URL` and carries `Authorization: Bearer
$OPSIFORCE_API_KEY`; `scripts/api.sh call` does that. Runtime calls go to the test Project's opencode
through the runtime proxy at `$OPSIFORCE_RUNTIME_PROXY_URL`, a different Service from the platform
API; `scripts/api.sh runtime <baseUrl> …` resolves the Connection's `baseUrl` against it.

Your key acts as the human who created this chat and reaches **only Projects this chat created**.
Anything else answers 404, so a cleanup mistake cannot touch someone's work.

## 0. Resume — which test Project is mine?

The API deliberately hides `kind`-stamped Projects from `GET /projects`, so the list will **not** show
your test Project. Remember its id yourself, in the workspace, and confirm it by id:

```sh
# after every create:
echo '{"projectId":"'"$P"'","agentId":"'"$A"'","createdAt":"'"$(date -Is)"'"}' > scratch/test-project.json

# on resume:
P=$(jq -r .projectId scratch/test-project.json 2>/dev/null || true)
[ -n "$P" ] && sh scripts/api.sh status GET "/projects/$P"   # 200 = still there, 404 = gone
```

`GET /projects/$P` works for the id even though the list omits it. If the note is missing or the id
is gone, just create a new one — a create supersedes any predecessor anyway (step 2).

## 1. Delete the predecessor

A test Project is single-use: it froze the child's definition at its creation moment. Starting a new
test replaces the old one.

```sh
sh scripts/api.sh call DELETE "/projects/$P"      # 204, permanent, no undo
```

You do not have to: `POST /projects` with `kind: "test"` deletes this chat's previous test Project
itself. Delete explicitly when the author is finished testing, or before a slow create so the old
Project is not lingering while you wait. `DELETE` needs `can_delete_project` on the person this chat
runs as — a 403 here is that permission, not a bug, and the automatic supersede still works.

## 2. Create the test Project

```sh
A=$AGENT_ID   # the child Agent's id, from POST /agents or GET /agents
P=$(sh scripts/api.sh call POST /projects \
      '{"agentId":"'"$A"'","title":"Test: release notes","kind":"test"}' | jq -r .id)
```

- `kind: "test"` is accepted **only** from a Builder chat; anywhere else it is a 422.
- It is created on the child's **Development** profile — the one this chat edits — and is hidden from
  every Project list while remaining openable from this chat by the author.
- `title` is at most 30 characters.

## 3. Wait for it to be ready

One blocking line; a cold create is tens of seconds:

```sh
until [ "$(sh scripts/api.sh call GET "/projects/$P" | jq -r '.environments[0].status')" = "active" ]; do sleep 5; done
```

`environments[0]` is Development. Other statuses worth recognising: `starting` (keep waiting),
`failed` (stop — report it and do not prompt), `pending`/`claiming` (still being built). Put a ceiling
on your own patience: if it is still not active after a couple of minutes, say so rather than looping
forever.

## 4. Connect

```sh
E=$(sh scripts/api.sh call GET "/projects/$P" | jq -r '.environments[0].id')
C=$(sh scripts/api.sh call POST "/projects/$P/environments/$E/connect")
BASE=$(printf '%s' "$C" | jq -r .baseUrl)
SES=$(printf '%s' "$C" | jq -r .sessionId)
```

`connect` wakes the environment inside a 30-second budget and binds the primary Session. A 503 with
`Retry-After` means still starting — retry, do not treat it as a failure.

## 5. Prompt, wait, read

Everything from here is opencode's own API, forwarded verbatim by the proxy. The authoritative
reference is the `openapiUrl` the Connection reported.

```sh
sh scripts/api.sh runtime "$BASE" POST "/api/session/$SES/prompt" \
  '{"id":"msg_'"$(date +%s)"'","text":"Write release notes for the two merged PRs in the repo."}'
sh scripts/api.sh runtime "$BASE" POST "/api/session/$SES/wait"          # returns when the Session goes idle
sh scripts/api.sh runtime "$BASE" GET  "/api/session/$SES/message?limit=10&order=desc"
```

- Send your own `id` (prefix `msg_`) so a retry is harmless: the runtime readmits the same id and body
  and conflicts on a different one.
- `wait` means *the Session went idle*, not *your prompt succeeded*. Read the outcome from the
  checks in step 6, not from the messages.
- One Session, one workspace, prompts in sequence. Keep every prompt of the run in this Project; the
  contract in `SKILL.md` says why a second and a third prompt are not optional.
- **Ask for checks, not a verdict.** End a test prompt with *"report each check you made and what it
  returned, not a summary"*. "Layout checks passed" is a bundle you can only take or leave; the separate
  results behind it are things you can re-run and disagree with. Put this in the prompt you send, never
  in the Agent's own body — the body is the product and ships to real users.
- `POST /api/session/$SES/interrupt` stops a child that is going nowhere.

## 6. Verify — the shell for files and data, your own browser for the page

Every machine-checkable row in `scratch/<agent>.expectations.md` already names the command that
decides it. Grading is running those commands; nothing here asks you to decide what to believe.

### The test Project's shell

Session-free, so it stays out of the child's transcript:

```sh
run() {
  # timeout is in MILLISECONDS — 60 would kill the command after a sixteenth of a second.
  id=$(sh scripts/api.sh runtime "$BASE" POST /api/shell "{\"command\":$(jq -Rn --arg c "$1" '$c'),\"timeout\":60000}" | jq -r .data.id)
  until [ "$(sh scripts/api.sh runtime "$BASE" GET "/api/shell/$id" | jq -r .data.status)" != "running" ]; do sleep 2; done
  sh scripts/api.sh runtime "$BASE" GET "/api/shell/$id/output" | jq -r .data.output
}

run 'cat /workspace/app/app.meta.json'                     # go-live: does it exist, is it {name, description}
run 'ls -l /workspace/app/startup.sh'                      # the App contract: present and executable
run 'curl -s -o /dev/null -w "%{http_code}" localhost:$APP_PORT'   # anything answering counts as serving
run 'ls -1 /workspace/.opencode/skills'                    # the Skills the Agent actually carries
run 'head -40 /workspace/.opencode/agents/*.md'            # the prompt as delivered
run 'sqlite3 /workspace/app/data/app.db ".tables"'         # the App's own database, if it keeps one
run 'sqlite3 -header -column /workspace/app/data/app.db "select * from <table> limit 20;"'
```

For crashes, error lines and failed requests, run the queries the `platform` skill gives (§Verify the
App booted, §Investigate failed requests and crashes) through `run`. They are the same queries the child
is supposed to run on itself, kept in one place so this file cannot drift from them. A recent `crashed`
with a climbing `restart_count` is a crash loop, and it outranks anything the child said about itself.

For an Agent with no App, the checks are whatever its job is: a file it was asked to write, a row it
was asked to insert, the exit code of a command it claimed to run.

Everything through `run` is a **read**. Do not create, edit or delete the child's files or rows from
here — if a check needs different data, put it in the way a user would, through the page or the App's
API, and let the child fix its own code through a prompt.

### Data written in one prompt, read back after the next

The App's database at `/workspace/app/data/app.db` is the child's own. Read a row the child claims to
have written rather than believing the claim, and read it again after the *next* prompt — a schema
change that drops the table takes the data with it, and only a warm workspace shows that.

```sh
run 'sqlite3 /workspace/app/data/app.db "select count(*) from <table>;"'   # before prompt 2, and after
```

### The Skills it carries, and the ones it used

A listing of `.opencode/skills` proves delivery, not use. For an executable Skill, check the file is
present and `-rwx` and runs under the child's node; then prove *use* from the artefact only that Skill
could produce — run its script yourself on the same input and compare bytes with what the App serves,
and, where the Skill says to copy the script rather than re-implement it, compare hashes:

```sh
run 'ls -l /workspace/.opencode/skills/<name>/scripts/'
run 'printf %s "<sample input>" | node /workspace/.opencode/skills/<name>/scripts/<script>'
run 'md5sum /workspace/.opencode/skills/<name>/scripts/<script> /workspace/app/scripts/<script>'
```

Identical bytes and identical output settle it. A hand-rolled re-implementation that happens to match
on one case does not, so pick an input the format's edge cases show up in.

### The page: look at it yourself

The child's App answers on its own address inside the platform, and this Project reaches that address
directly. Ask the test Project's shell for it once, then drive `agent-browser` from **here**, so every
screenshot lands in your own workspace where you can read it:

```sh
APP="http://$(run 'hostname -i' | tr -d '[:space:]'):$(run 'echo $APP_PORT' | tr -d '[:space:]')"
mkdir -p scratch/shots
agent-browser --session test open "$APP"
agent-browser --session test set viewport 375 812          # the narrow width is the one worth checking
agent-browser --session test reload
agent-browser --session test wait --load networkidle
agent-browser --session test screenshot scratch/shots/<agent>-375.png
agent-browser --session test snapshot                      # the accessibility tree: every label, control, value
agent-browser --session test eval "document.documentElement.scrollWidth > innerWidth"
agent-browser --session test console
agent-browser --session test close
```

Then **read the screenshot** — it is a file in your workspace and you can see it. The snapshot answers
how many options a select has, whether an edit control exists and what the headline number reads;
`eval` answers anything else you wrote a command for; `console` shows errors the page swallowed. Redo
the sequence after every prompt that changes the page. Your browser session is your own and does not
disturb the child's.

Two cautions, both learned the hard way:

- **Ask only about what a person can reach.** Counting inputs without labels catches a component
  library's hidden value-carriers unless you exclude `aria-hidden` and unfocusable ones, and reports a
  defect the page does not have.
- **When your check disagrees with the child, find out which of you is wrong before reporting it.** A
  false positive spent as a defect costs the author more than the check saved.

What you leave to the author is taste: whether the page is pleasant, whether the spacing reads,
whether a message helps. They have the test Project's preview open beside this chat — point them there.

## 7. Report and clean up

Report against the expectations you wrote before the run, machine-checkable first, **in plain
language**. The commands are how you grade; they are not what you say. "I added two expenses, reloaded,
and the totals and the CSV were still right — and the page holds up on a phone" is the report. A list
of shell lines is not, and neither is a transcript.

Two things do belong in it: **which passes you saw for yourself and which you are relaying from the
child**, and any check you did not run — that one is neither a pass nor a fail.

Leave the test Project alive while the author might want to open it — it is openable from this chat,
and the transcript and App pane are the most useful thing about a failed run. Delete it when they are
done, or let the next create supersede it.
