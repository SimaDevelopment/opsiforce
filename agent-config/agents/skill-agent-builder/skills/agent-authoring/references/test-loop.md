# The test loop, exactly

Every platform call is relative to `$OPSIFORCE_API_URL` and carries `Authorization: Bearer
$OPSIFORCE_API_KEY`; `scripts/api.sh call` does that. Runtime calls go to the test Project's opencode
through the runtime proxy at `$OPSIFORCE_RUNTIME_PROXY_URL`, a different Service from the platform
API; `scripts/api.sh runtime <baseUrl> …` resolves the Connection's `baseUrl` against it.

Anything outside the Projects this chat created answers 404, so a cleanup mistake cannot touch
someone's work.

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

A new test replaces the old test Project.

```sh
sh scripts/api.sh call DELETE "/projects/$P"      # 204, permanent, no undo
```

You do not have to: `POST /projects` with `kind: "test"` deletes this chat's previous test Project
itself. Delete explicitly when the author is finished testing, or before a slow create so the old
Project is not lingering while you wait. `DELETE` needs `can_delete_project` on the person this chat
runs as — a 403 here is that permission, not a bug, and the automatic supersede still works.

## 2. Create the test Project

```sh
A=$(sh scripts/api.sh call GET /me | jq -r .builderSubject.id)
P=$(sh scripts/api.sh call POST /projects \
      '{"agentId":"'"$A"'","title":"Test: release notes","kind":"test"}' | jq -r .id)
```

- `kind: "test"` is accepted **only** from a Builder chat; anywhere else it is a 422.
- It is created on the child's **Development** profile — the one this chat edits — and is hidden from
  every Project list while remaining openable from this chat by the author.
- `title` is at most 30 characters.

## 3. Wait for it to be ready

One blocking line with a ceiling; a loop with no end is how a test run turns into a stuck chat:

```sh
wait_active() {   # $1 = attempts of 5 s; 36 is three minutes
  for i in $(seq 1 "${1:-36}"); do
    s=$(sh scripts/api.sh call GET "/projects/$P" | jq -r '.environments[0].status')
    [ "$s" = "active" ] && return 0
    [ "$s" = "failed" ] && { echo "environment failed"; return 1; }
    sleep 5
  done
  echo "still $s after $((${1:-36} * 5)) s"; return 1
}
wait_active || exit 1
```

`environments[0]` is Development. Other statuses worth recognising: `starting` (keep waiting),
`failed` (stop — report it and do not prompt), `pending`/`claiming` (still being built). When the
ceiling is hit, say so in the report rather than looping again.

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
- **A child's turn can take many minutes, and `wait` holds until it ends.** Your shell stops a
  command after two minutes unless told otherwise, so run the `wait` call with the shell tool's
  `timeout` set to `1200000` (twenty minutes). Its return is the only signal you need; do not poll.
- **When `wait` comes back without the child idle** — the ceiling hit or the connection dropped —
  look once at the latest messages. Anything new since your prompt (a message, a tool call, a command
  still producing output) means it is working: call `wait` again.
- **Idle is not finished.** After every `wait`, read the child's last assistant message. A finished
  turn ends on `"finish":"stop"`. `"finish":"error"` (it carries an `error`), or a last message that
  still says `"finish":"tool-calls"`, means the turn broke off, whatever the cause — your interrupt, a
  pod restart, a model error. Do not grade a broken turn. Send one prompt — *"Your last turn was cut off.
  Continue where you stopped, then report each check you made and what it returned."* — and `wait`
  again. A second broken turn is a stall: report the turn as unfinished.
- One Session, one workspace, prompts in sequence; `SKILL.md` says why a second and a third prompt are
  not optional.
- **Ask for checks, not a verdict.** End a test prompt with *"report each check you made and what it
  returned, not a summary"*. "Layout checks passed" is a bundle you can only take or leave; the separate
  results behind it are things you can re-run and disagree with. Put this in the prompt you send, never
  in the Agent's own body — the body is the product and ships to real users.
- `POST /api/session/$SES/interrupt` is for a genuine stall only: nothing new for about five minutes,
  or the same failing command repeating — never while a build, an install or a test is still running.
  An interrupted turn is a stall, not a failure of the definition: say so in the report, and prompt the
  child once to continue or report it unfinished — never start another run to see if it was a fluke.

## 6. Verify — the shell for files and data, your own browser for the page

Grading is running the command each machine-checkable line of `scratch/<agent>.expectations.md`
names.

### The test Project's shell

Session-free, so it stays out of the child's transcript. A shell call does not remember the last one,
so put `run` and `wait_active` in `scratch/helpers.sh` once and start every shell call that uses them
with `. scratch/helpers.sh`:

```sh
run() {
  # timeout is in MILLISECONDS — 60 would kill the command after a sixteenth of a second.
  id=$(sh scripts/api.sh runtime "$BASE" POST /api/shell "{\"command\":$(jq -Rn --arg c "$1" '$c'),\"timeout\":60000}" | jq -r .data.id)
  for i in $(seq 1 45); do   # the runtime kills the command at 60 s; 90 s here means the runtime itself is gone
    [ "$(sh scripts/api.sh runtime "$BASE" GET "/api/shell/$id" | jq -r .data.status)" != "running" ] && break
    sleep 2
  done
  sh scripts/api.sh runtime "$BASE" GET "/api/shell/$id/output" | jq -r .data.output
}

run 'cat /workspace/app/app.meta.json'                     # go-live: does it exist, is it {name, description}
run 'ls -l /workspace/app/startup.sh'                      # the App contract: present and executable
run 'cat /workspace/app/startup.sh'                        # every service the Architecture names: ensured, under guard, before the server?
run 'find /workspace/app -maxdepth 3 -type d -not -path "*/node_modules*" -not -path "*/.yarn*"'   # the layout the Architecture names
run 'curl -s -o /dev/null -w "%{http_code}" localhost:$APP_PORT'   # anything answering counts as serving
run 'ls -1 /workspace/.opencode/skills'                    # the Skills the Agent actually carries
run 'head -40 /workspace/.opencode/agents/*.md'            # the prompt as delivered
run 'sqlite3 /workspace/app/data/app.db ".tables"'         # the App's own database, if it keeps one
run 'sqlite3 -header -column /workspace/app/data/app.db "select * from <table> limit 20;"'
```

The `sqlite3` lines here and below read the default starter's database. When the Architecture section
replaced it, read the App's data with that store's own client instead — the Skill the body names for
it says how.

When the Architecture section replaced any layer of the starter, one machine-checkable expectation
says the old layer is gone — its package out of the manifest, its code out of `app/` — because the
Agent otherwise runs two of that layer, and the stack Skill for the old one still reads as current.

For crashes, error lines and failed requests, run the queries the `platform` skill gives (§Verify the
App booted, §Investigate failed requests and crashes) through `run`. They are the same queries the child
is supposed to run on itself, kept in one place so this file cannot drift from them. A recent `crashed`
with a climbing `restart_count` is a crash loop, and it outranks anything the child said about itself.

For an Agent with no App, the checks are whatever its job is: a file it was asked to write, a row it
was asked to insert, the exit code of a command it claimed to run.

Everything through `run` is a **read** — `SKILL.md` says why.

### Data written in one prompt, read back after the next

The App's database at `/workspace/app/data/app.db` is the child's own. Read a row the child claims to
have written rather than believing the claim, and read it again after the *next* prompt — a schema
change that drops the table takes the data with it, and only a warm workspace shows that.

```sh
run 'sqlite3 /workspace/app/data/app.db "select count(*) from <table>;"'   # before prompt 2, and after
```

### The Skills it carries, and the ones it used

A listing of `.opencode/skills` proves delivery, not use. Use shows in the App: the structure a stack
Skill describes is the one on disk, its contracts hold for what the App actually produces, and its
definition-of-done checks pass when you run them yourself. When the Skill ships a checker in
`scripts/`, run it on the App's real output — an export it made, a response it served — not on a
sample of your own:

```sh
run 'ls -l /workspace/.opencode/skills/<name>/scripts/'
run 'node /workspace/.opencode/skills/<name>/scripts/<checker> <what the App produced>'
```

Pick an output the contract's edge cases show up in; one easy case passing proves little.

A scaffold's `check-skeleton.sh` is one expectation in every run of its Agent, graded after each
prompt and again after the restart:

```sh
run 'bash /workspace/.opencode/skills/<name>/scripts/check-skeleton.sh; echo "exit=$?"'   # every line PASS, exit=0
```

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

### Restart the pod, then check again

Once the App is live, recreate the child's pod — once per run; a restart before go-live proves
nothing. The container is thrown away and `startup.sh` runs from cold on the same workspace, as when
the Project idles out and is resumed:

```sh
sh scripts/api.sh call POST "/projects/$P/restart"                    # 204: the pod is being recreated
wait_active || exit 1
C=$(sh scripts/api.sh call POST "/projects/$P/environments/$E/connect")   # a new pod is a new Connection
BASE=$(printf '%s' "$C" | jq -r .baseUrl)
run 'curl -s -o /dev/null -w "%{http_code}" localhost:$APP_PORT'          # serving again?
run 'sqlite3 /workspace/app/data/app.db "select count(*) from <table>;"'  # data still there?
```

Then re-run the page sequence once.

## 7. Report and clean up

Report against the expectations you wrote before the run, machine-checkable first — what you expected,
what you saw, what you changed — **in plain language, not shell lines** and not a transcript: "I added
two expenses, reloaded, and the totals and the CSV were still right — and the page holds up on a
phone."

Link every screenshot you took to decide a pass as a workspace path —
`[phone, 375px](/workspace/scratch/shots/<agent>-375.png)` — which opens as a preview beside the chat,
so the author sees what you looked at. A bare path in backticks opens nothing, and a "looks right" with no screenshot
is a claim the author cannot check.

Say **which passes you saw for yourself and which you are relaying from the child**, and name any check
you did not run — it is neither a pass nor a fail. A 200 from the App is availability, not
correctness: the pass is the expectation met by the content, the row or the page you checked.

Leave the test Project alive while the author might want to open it — it is openable from this chat,
and the transcript and App pane are the most useful thing about a failed run. Before a new create
supersedes it, copy what the next run will need to compare against into `scratch/` — the failing
command and its output, the screenshot — because the create deletes the old Project with its
workspace. Delete it when the author is done.
