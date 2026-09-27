# The test loop

Testing an Agent, end to end: the contract first, then the steps in order (§1–6). Test after writing
or meaningfully changing a definition, **without being asked**, the way a coding agent runs the build.

## The contract

- **Announce first, with the spend.** One line before you start: what you will run, roughly how long it
  takes and what it spends (the first two fidelity gaps below). Then go, without waiting for a reply.
- **The chat has one Test Project**, created once (§2) and refreshed in place after every save (§5). It
  reads what you last saved (§1). Never refresh for an unchanged definition, and test a change once the
  author has finished describing it.
- **Write expectations before the run**, into `scratch/expectations.md`, in the shape
  `scripts/check-expectations.mjs` checks:
  - **`## Prompts`** — one line per prompt, sent word for word every round. A change under test adds
    its prompt at the end.
  - **`## Machine-checkable`** — a file exists, a row is there, the App answers again after its pod is
    restarted, and, for an Agent with a Template, the directories it laid are still there. One line
    each: ``- <expectation> — `<command>` → <the answer that passes>``.
  - **`## Judgement`** — tone, whether a refusal was graceful, whether the page is understandable.
  - **`## Fixes`** — the fix log (§Rounds).

  *If you cannot write the command, it is a judgement expectation.* Deciding that beforehand is the
  point; deciding it afterwards, against a confident report, is how a claim gets graded as a fact.
- **The expectations file is the Agent's, not the run's.** This chat is the only one that authors the
  Agent, so the file outlives every run. Add to it; rewrite nothing in it. Each run grades every
  machine-checkable line still in it, plus the new ones for the change under test — a change that
  breaks what passed before is a failure of that change. When the author changes behaviour on purpose,
  delete the lines that no longer hold, and name them in your report.
- **Several prompts, one warm workspace.** A child that builds something correct once and breaks it on
  the next instruction passes a single-prompt test and fails in use. Make the second prompt change what
  the first built, then re-run the first prompt's checks. A third prompt that asks for something the
  Agent should refuse is the only way to see the refusal under real conditions.
- **When the Project has a `startup.sh`, restart the child's pod once it is live, and check again**
  (§4).
- **A secret the job needs goes in the Test Project's Environment settings**, as every Environment
  carries its own. Name the key the author sets there, never its value, and mark each line that needs
  it *not checked* until the value is there.

### Who checks what

- **The child** checks its own work the way its skills and body tell it to. What the runtime recorded
  it doing — each command with its output and exit code, the files and screenshots it saved — is
  **evidence**. What it writes about itself is a **claim**.
- **You** read that record against the expectations, then:
  - use the result once the way the brief's user would: run the App's main flow in your own browser,
    or open the file it delivered and read it against the brief;
  - check every expectation the record does not cover — a line is **covered** only when a command the
    child ran after the last change decides it;
  - re-run at least one covered line, the one your verdict leans on most. When it disagrees with the
    record, distrust that run's records and re-run every covered line.

  Pages with **your own** `agent-browser`; files, data and logs through the Test Project's shell (§4).
- **The author** judges what needs a person's eye — whether the page is pleasant, whether a message
  helps — in the Test Project's preview beside this chat, and decides publishing. Point them there
  rather than grading taste on their behalf.

**The shell is for looking: files, rows, logs.** Its only writes are the platform's refreshes and
removing a file a Template update dropped. Change what the App holds only the way a user would —
through its page or its API. A row you delete by hand is a state no user can reach, and it hides the
bug that a user would have hit.

### Whose failure it is

Decide from the record, not from what the child says:

- **Template** — before doing what was asked, the child had to create, repair or install something
  the Template should have given it, or it failed on a file it was given.
- **Body** — it did something a stated rule would have prevented, or did not know what finished means.
- **Skill** — it followed wrong know-how or lacked know-how it needed. A shared built-in Skill is the
  author's to raise, not yours to fix: tell the author and work around it in the body. Never add a
  Skill with the same name.
- **Slip** — the rule exists and it ignored it once. Prompt it to fix that in the same session and
  change nothing.

### Rounds

A **round** is one pass through `## Prompts`. Re-prompt slips on the spot; log every other fault and
run the round to its last prompt, unless the child cannot go on. At round end, in this order:

1. **Log the fixes.** One line per fix under `## Fixes`:
   `- R<n> · <failed expectation> · <template|body|skill> · <the record that showed it, in words> · <what you change> · <update|reset>`,
   the last field being the round's one refresh.
2. **Apply** every logged fix together.
3. **Check, save, refresh** — one of each: the check `template.md` gives, the save (§1), and the
   refresh §5 decides before the save.
4. **Run the next round.** After a reset, from the first prompt. After an update the workspace still
   holds what the prompts built: re-grade every machine-checkable line on it, then send the prompts
   whose lines failed and any new one. A round with nothing to fix ends in the report (§6).

Two fixing rounds in a row that turn no failing line into a pass is the point to stop, show the author
`## Fixes`, and ask. That stop rule, not the budget, is what ends a runaway loop.

### The four fidelity gaps — say them when they matter

- A Test Project is **always cold** — a Custom Agent keeps no warm pool, so create takes tens of
  seconds and the first prompt is slower than a user's.
- Its **spend lands on this Organization** like any Project, and shows in Admin storage.
- **External services it calls are the real ones** — if the child emails, posts or writes somewhere,
  that happened. So a prompt that makes the child send, post or change something outside the Project
  targets something the author owns and named in the brief; with none, leave that prompt out and mark
  its line *not checked*.
- It tests the definition **as of its last refresh**; after an update, its conversation is not a
  clean start.

## `scripts/tp.sh`

Every step below is one `sh scripts/tp.sh <command>`, and its state in `scratch/test-project.json`
carries over to a new shell or a resumed chat. For a call it lacks: `scripts/api.sh call` (the
platform) and `runtime <baseUrl>` (the Test Project, through the runtime proxy); outside this chat's
Projects, 404.

## 1. Save first

The Test Project lays the Agent's Development as last saved — prompt, model, Skills and Template —
never `template/` itself. Save (`template.md`) before the create and before every refresh (§5).

## 2. Bring it up

```sh
sh scripts/tp.sh up
```

It finds the chat's one Test Project, or creates it on this chat's Agent, waits for it and connects.
The Project reads the Agent's **Development** for everything, and no Project list shows it: the author
opens it from this chat.

- The wait has a ceiling of three minutes. When it is hit, say so in the report rather than looping
  again.
- A `failed` environment means the pod could not start — most likely node capacity, never the
  Template. `up` retries it once through a restart; a second failure is where you stop and say so.
- **`disabled:`** — someone switched the Test Project off. Say once that it comes back from the Test
  run pane's menu beside this chat, run the checks the change allows without it, and report the
  definition *saved*, not *tested*.
- The `openapi` path `up` prints is the runtime's own reference for any call you add.

## 3. Prompt, wait, read

```sh
sh scripts/tp.sh prompt '<the next line of ## Prompts, word for word>'
```

It sends the prompt and waits for the turn. Run it, `tp.sh turn` and `tp.sh answer` with the shell
tool's `timeout` set to `1200000` (twenty minutes): the wait ends at `TURN_TIMEOUT` seconds (default
900), always before your shell stops it.
Wait only through `tp.sh`: the runtime's own `wait` has no deadline, and a turn held by a Form never
goes idle, so it would hold your shell for good. Its exit code says what the turn did:

- **Exit 0, finished.** The Session went idle on a finished turn — which is not *your prompt
  succeeded*. Read the outcome from the record and your own checks (§4), not from the child's prose.
- **Exit 4, the deadline.** A long turn is not a stuck one: a child's turn can take many minutes. Look
  once at the latest messages (`tp.sh evidence`): anything new since your prompt or your last look means
  it is working, so run `sh scripts/tp.sh turn` again. Nothing new across two deadlines is a stall.
  Report a timed-out turn as unfinished.
- **Exit 5, a broken turn** — your interrupt, a pod restart, a model error. Grade only a finished turn:
  send *"Your last turn was cut off. Continue where you stopped."* once, and a second exit 5 is a stall:
  report the turn unfinished.
- **Exit 3, a Form.** The child asked the user a question, printed with its fields, and its turn waits
  for the answer. Answer it as the author's user would:

  ```sh
  sh scripts/tp.sh answer '{"<field key>":"<the option value you chose>"}'
  ```

  - **The answer comes from the author's intent**: the brief and this prompt's lines in the
    expectations file. Pick the option a user who wants that would pick, on its meaning — its position
    and a "(Recommended)" label carry none.
  - When no option fits, give the one closest to the expectations, or, when the field allows
    `custom`, a short answer in the user's own words.
  - One entry per field: a `string` field takes one value, a `multiselect` field an array of values.
    A refusal saying the Form is already settled means someone answered it in the preview: run
    `sh scripts/tp.sh turn`. Any other refusal names what it rejected: fix the answer and send it again.
  - Always answer a Form, never cancel it: a dismissed question ends the child's turn in an error, a
    broken turn you caused.
  - Note every Form in the round's report (§6): the question, the answer you gave and why, and say so
    when no option fitted. A question is part of the record, so judge whether asking was right against
    the expectations, as you would any other thing the child did.
- One Session, one workspace, prompts in sequence; §The contract says why a second and a third prompt
  are not optional.
- **Write test prompts the way a user would**: ask for the result, and leave how to test and what to
  report to the child — telling it makes it test harder than it does for real users.
- `sh scripts/tp.sh interrupt` is for a genuine stall only: nothing new for about five minutes with no
  Form open, or the same failing command repeating — while a build, an install or a test still runs, it
  is working. An interrupted turn is a stall, not a failure of the definition: say so in the report, and
  prompt the child once to continue or report it unfinished. A reset is never the way to see if it was
  a fluke.

## 4. Verify — the child's record first, then your own checks

Grade every machine-checkable line of `scratch/expectations.md` in three steps: read the record, check
what it does not cover, re-run one line it does cover (§Who checks what).

### The child's record

```sh
sh scripts/tp.sh evidence
```

Each command the child ran since your last prompt, with its exit code and output, and each question it
asked — `question (open)` is a Form nobody has answered yet; its screenshots land in `scratch/shots/`
as `child-<name>`. Mark each line **covered** when a command recorded after the last change decides
it, and a **gap** otherwise.

### The Test Project's shell

For the gaps and your re-run. `tp.sh sh` runs one command in the Test Project, session-free so it stays
out of the child's transcript, prints all of its output and exits with its exit code:

```sh
sh scripts/tp.sh sh 'curl -s -o /dev/null -w "%{http_code}" localhost:$APP_PORT'   # anything answering counts as serving
sh scripts/tp.sh sh 'ls -1 /workspace/.opencode/skills'                   # the Skills the Agent actually carries
sh scripts/tp.sh sh 'head -40 /workspace/.opencode/agents/*.md'           # the prompt as delivered
sh scripts/tp.sh sh 'git -C /workspace log --oneline | tail -3'           # "Initial template", then any "Template update"
sh scripts/tp.sh sh 'find /workspace -maxdepth 3 -type d -not -path "*/node_modules*" -not -path "*/.*"'   # the Template's directories, still there
```

The `platform` skill's boot and crash queries are the child's to run. Run them through `tp.sh sh` only
when its record has none since the last change. A recent `crashed` with a climbing `restart_count` is
a crash loop, and it outranks anything the child said about itself.

Everything through `tp.sh sh` is a **read** (§Who checks what).

### The page: look at it yourself

The child's App answers on its own address inside the platform, and this Project reaches that address
directly. Drive `agent-browser` from **here**, so every screenshot lands in your own workspace where you
can read it:

```sh
APP=$(sh scripts/tp.sh app-url)
mkdir -p scratch/shots
agent-browser --session test open "$APP"
agent-browser --session test wait --load networkidle
agent-browser --session test screenshot scratch/shots/<what>.png
agent-browser --session test snapshot                      # the accessibility tree: every label, control, value
agent-browser --session test console
agent-browser --session test close
```

These commands are all this loop needs; load `agent-browser` only for one they do not cover.

Then **read the screenshot** — it is a file in your workspace and you can see it. The snapshot answers
how many options a select has, whether an edit control exists and what the headline number reads;
`agent-browser --session test eval "<expression>"` answers anything else you wrote a command for;
`console` shows errors the page swallowed. Use it for the main job, for page lines the record does not
cover, and for your one re-run. Set a viewport only when an expectation names a width. Your browser
session is your own and does not disturb the child's.

Two cautions, both learned the hard way:

- **Ask only about what a person can reach.** Counting inputs without labels catches a component
  library's hidden value-carriers unless you exclude `aria-hidden` and unfocusable ones, and reports a
  defect the page does not have.
- **When your check disagrees with the record, find out which is wrong before reporting it.** A false
  positive spent as a defect costs the author more than the check saved; a record that was wrong means
  re-running every covered line.

### Restart the pod, then check again

When the Project has a `startup.sh`, recreate the child's pod once per round after it is live; a
restart before go-live proves nothing. `sh scripts/tp.sh restart` throws the container away, waits and
connects again: `startup.sh` runs from cold on the same workspace, as when the Project idles out and is
resumed. Then check it serves again and re-run the line your verdict leans on.

## 5. Refresh: update or reset

Every refresh lays what was last saved — save first (§1). Both are this chat's alone. One rule decides
which, for a round's fixes and for a change the author asked for alike, and the word it turns on is
**touched**:

> The child **touched** or built on what the change alters, or the change is in the body or a Skill
> (a re-pinned Version included) → **reset**. Otherwise → **update**.

Decide *touched* for Template files by command, after the check and before the save:

```sh
sh scripts/tp.sh touched
```

Each `touched <path>` is a file both the child changed since the last lay and the save changes, taken
from `template-snapshot.sh diff`; `untouched` means none. A Template file the child never opened, including one the change adds, is
untouched. *Built on* — the child relying on a file it never edited — is yours to judge from the
record. An update lays only Template files — it keeps the prompt and the pinned Skills the Project was
laid with, so a body or Skill change reaches the child only through a reset.

Run one of the two:

```sh
sh scripts/tp.sh update   # the saved Template over the workspace, committed as "Template update"
```

```sh
sh scripts/tp.sh reset    # wipe and lay as at create, a new Session and a fresh budget
```

- **Update** overwrites and adds and deletes nothing: remove each `dropped <path>` that `touched`
  printed with `tp.sh sh`. When something that runs changed, restart the pod (§4) afterwards. The
  conversation carries on.
- **Reset** keeps the Project, its preview and its side pane, but not its workspace or conversation.
  Copy into `scratch/` whatever the next round compares against first; `reset` then waits and connects
  the new Session.

## 6. Report

Results live in the conversation — there is no stored run. Fill in this shape after every test run,
in plain language — what you did as the user would and what the App or the files showed afterwards,
not shell lines or a transcript:

```markdown
**What I tested:** <the definition as last saved, the prompts in one line each, update or reset>

**Expectations**
- <expectation> — <pass | fail> (<mine | the child's record: …>) — <what you saw, with the screenshot link>
- <expectation> — not checked — <why>
- …judgement lines last, with what the author should look at in the preview

**Forms the child raised**
- <the question> — <the answer you gave, and why; say so when no option fitted>

## Fixes
- <each line of the expectations file's `## Fixes`, in words>

**Not covered:** <what nothing checked, and why>
```

- A graded line carries exactly one source: **mine** (checked myself) or **the child's record** (name
  the record in words: "the test command it ran after the second prompt"). A line nothing decided is
  **not checked**, its own line shape, which is neither a pass nor a fail. A line that passed only after
  an update adds *passed after a Template update*.
- A 200 from the App is availability, not correctness: the pass is the expectation met by the content,
  the row or the page you checked.
- Link every screenshot that decided a pass as a workspace path, labelled with who took it —
  `[after the restart, mine](/workspace/scratch/shots/restart.png)` — which opens as a preview beside
  the chat, so the author sees what you looked at. A bare path in backticks opens nothing, and a
  "looks right" with no screenshot is a claim the author cannot check.
- Write *none* under a heading with nothing in it, so an empty one reads as checked.

**The report is done when:**

- `node scripts/check-expectations.mjs` exits 0;
- every expectation line is either `pass` or `fail` with one source, or `not checked` with its why;
- `## Fixes` has one entry per fixing round, matching the expectations file;
- every Form the child raised is listed with its answer: every `question` entry `tp.sh evidence`
  printed.

Leave the Test Project alive: it lives as long as this chat, it is openable from here, and its
transcript and App pane are the most useful thing about a failed run.
