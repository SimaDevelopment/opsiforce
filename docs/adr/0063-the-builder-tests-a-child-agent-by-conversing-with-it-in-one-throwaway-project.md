# The Builder tests a child agent by conversing with it in one Test Project per chat

The Skill & Agent Builder writes Custom Agents, and a prompt checked only by the context that wrote it is contaminated by everything the author just said. A real Project gives the child a context with no Builder history in it. The child should check its own work as its Skills say, and the Builder should add checks of its own, because a different session judges work better than the one that did it. The two sides should not repeat each other.

**The Builder tests a child agent by conversing with it in the chat's one Test Project. What the runtime recorded the child doing is evidence, and what the child says about it is a claim. The Builder judges that record against expectations written from the brief, checks every gap and a short fixed set of lines itself, and fixes, checks, saves and refreshes the same Test Project in rounds until the child behaves.**

## The Test Project

- **One Project, one session, a conversation.** Prompts share one session and one warm workspace, because that is how a real user works. The failures worth catching show up only there: breaking what it already made, re-running its own migrations, not re-reading its own files. A second session inside the pod would run where the status watcher cannot see it, and Project↔session is 1:1.
- **Created like any Project, from Development.** The pod sends `POST /projects` with `kind: "test"`, which the API accepts only from a Builder chat's pod. The child's files are laid at create ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)) from its Development Agent Profile and Development Template, whatever its Default environment (Agent) is and even before its first Publish (Agent), because Development is what the chat edits ([ADR-0073](0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)). An Agent chat's Test Project runs only on the chat's subject. The API still takes a Skill chat's create on any Agent it can see, with that Agent's Development and so the Skill Version it pins; Skill chats leave it unused (below).
- **One per chat, refreshed in place.** A second create from the same chat answers 409 `test-project-exists` with its `testProjectId`, and deletes nothing; `GET /me` names the chat's Test Project as `builderTestProject`. Two backend refreshes keep it current, both open only to the gateway key of the chat that created it (`created_by_project_id`):
  - **Update** (`POST /projects/:id/test/update`) overlays the saved Development Template onto the workspace, overwriting and adding without deleting, and commits "Template update". The conversation and the running Bifrost spend carry on. The Builder removes a dropped file through the shell and restarts the pod when something that runs changed.
  - **Reset** (`POST /projects/:id/test/reset`) stops the pod, wipes the workspace, lays it as a create does, unpins the session so the next connect binds a new one, gives the Project a fresh Bifrost budget and starts the pod. The row, its side pane and its preview URL stay.

  Update fits a Template fault the child has not touched or built on. Reset fits a Template fault the child edited or worked around, and any fault in the body or the Agent's own Skills, because earlier turns stay in the model's context and it copies its own earlier behaviour. *Touched* is a command, not a memory: the files the child changed since the last lay, from the Test Project's git, intersected with the files the save changes, from `template/` against the snapshot of the last save, taken before the save. An Update over a file the child edited would overwrite the child's work and still pass. *Built on* stays the Builder's judgement from the record.
- **A disabled Test Project is not tested.** When someone switches it off, the Builder says once that it comes back from its pane's menu, runs the checks the change allows without it, and reports the definition saved, not tested. The public API has no route to enable it.
- **Hidden, and reached through the chat.** A Test Project is kind-stamped, so no list shows it. Whoever may reach its governing chat may reach it ([ADR-0064](0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)), and it opens beside the chat as an ordinary Project ([ADR-0066](0066-a-builder-chat-is-an-ordinary-project-surface-and-its-test-project-sits-beside-it-in-a-scrolling-strip.md)).
- **It lives as long as its chat, and nothing expires on a timer.** Deleting the chat's subject deletes the chat and its Test Project through the ordinary `ProjectService.remove`. There is no TTL and no reaper.
- **The Builder starts tests, and announces them.** After writing or meaningfully changing a definition it tests without being asked, the way a coding agent runs the build. First it says in one line what it will run, how long it takes and what it spends. The restraint is prompt text in `agent-authoring`: don't test a definition the author is still describing, and don't refresh for an unchanged one.
- **A Skill is tried in an Agent chat.** A Skill chat publishes and reads back. The Skill is tried in the chat of an Agent that carries it, once that Agent re-pins the new Version, because a Test Project lays the Versions its Agent pins: a Skill chat cannot re-pin another Agent, so a test it ran would exercise an older Version than the one it just published.

## Evidence and the child's checks

- Evidence is the child's tool calls in its transcript (command, captured output, exit code) and the files it saved. Its prose summary is a claim. The Builder may always run a check of its own on top.
- The child's definition of done has three layers:
  - The `platform` skill owns the loop for any stack: the boot and crash queries, and "when you carry `agent-browser`, walk the changed flow before saying it is done". Screenshots go to `/workspace/.cache/checks/`, which survives a pod recreate, is git-ignored and is left out of a Template save.
  - `web-app` keeps only its starter's own commands.
  - The Agent's body says what finished means for that Agent, derived from its brief. It may name a check script its Template ships.
- Test prompts read like a user's. They do not ask the child to report its checks, because that makes it test harder than it does for a real user.
- A Builder script, `scripts/tp.sh`, carries the whole Test Project mechanic: find or create, wait with a ceiling, connect, prompt under the Builder's own message id, wait for the turn with a deadline, answer a Form, read the record, run a shell command, find the App's address, refresh, and decide *touched*. Its state lives in `scratch/test-project.json`, so every shell call and a resumed chat carry on from the last one; the mechanics sit under the package's `node --test` suite instead of being retyped from Markdown every chat.
- `tp.sh evidence`, through `scripts/evidence.sh`, lists the shell calls the child made after the last prompt, with command, exit code and output, and copies the child's screenshots into the Builder's `scratch/shots/` through the runtime's file-read route. `scripts/turn.sh` tells a finished turn from one that broke off, by the last assistant message's finish reason.

## What the Builder checks itself

- It uses the result once the way the brief's user would — the App's main flow in its own `agent-browser`, or the delivered file read against the brief — and reads files, rows and logs through the Test Project's shell on the runtime proxy.
- When something runs (a `startup.sh` exists), it restarts the pod once per round and checks again.
- Nothing else is fixed. Other checks are expectations derived from the brief. "The folders the Template laid are still there" is a default expectation for any Agent with a Template.
- The expectations file is written before the run, only added to, and graded across several prompts on one warm workspace. It holds the prompts too, sent word for word every round, so every round is the same test. A secret the job needs is set by the author in the Test Project's Environment settings, as every Environment carries its own; until it is, the lines that need it are *not checked*. A prompt that makes the child write outside the Project targets something the author owns and named in the brief, or is left out. Results live in the conversation: no eval-suite entity, no stored runs.
- A machine-checkable line counts as covered by the child only when a command recorded after the change decides it. A line with no covering record is a gap, and the Builder checks it itself.
- After the last prompt, the Builder re-runs at least one covered check, the one the verdict leans on most. If the re-run disagrees with the record, it distrusts that run's records and re-runs every covered line.
- The Builder's shell in the Test Project is for looking. Its only writes are the refreshes and removing a file an Update dropped.

## The verdict

Each graded expectation is a pass or a fail with exactly one source: *mine* (checked myself) or *the child's record* (naming the record). A line nothing decided is *not checked*, its own line shape with its reason, which is neither a pass nor a fail. A line that passed only after a Template update says so. Every screenshot that decided a pass is linked and labelled by who took it. Judgement lines go to the author with a pointer to the Test Project's preview.

## The loop: check, save, test

1. **Check before every save**, by what changed:
   - no `template/`: nothing to check
   - only files that don't run changed: every path the body names exists, and every file opens with the tool the child will use to read it
   - something that runs changed: `scripts/check-template.sh` syncs `template/` into `/workspace/.cache/template-check/`, keeping what earlier setups installed there, runs the first-time setup the body and Skills tell the child to do, starts `startup.sh` in development on a spare port, waits for any HTTP answer, keeps the logs and kills the process group. With a manifest but no `startup.sh` it runs the setup and reports that there is nothing to boot. It runs inside the Builder's pod and needs no new pod.
   - `startup.sh` or what its production branch builds changed: the same check once more with `--production`, which boots a fresh copy of only what git would track, with no setup, under `OPSIFORCE_ENV=production`, the way Publish (App) does. Nothing else ever runs a Template's production branch before a user's first Publish (App).

   The check exists because the child has root and is told to install what a task needs: it would quietly repair a broken Template, the test would look green, and every real Project would still get the broken files.
2. **Save** the Development Template and Profile.
3. **Test**: create the chat's Test Project the first time, and Update or Reset it after every later save.

## Triage and rounds

- Each failed expectation is classed from the child's record:
  - **Template:** the child had to create, repair or install something the Template should have given it, or failed on a file it was given.
  - **Body:** the child did something a stated rule would have prevented, or did not know what finished means.
  - **Skill:** the child followed wrong know-how or lacked what it needed. The Builder cannot change a shared built-in Skill: it tells the author and works around it in the body, and never adds an override of the same name, because the reconciler would make that override a Version of the shared Skill.
  - **Slip:** the rule exists and the child ignored it once. The Builder prompts again and changes nothing.
- Every fix is one line in a `## Fixes` section of the expectations file, in one grammar: the round, the failed expectation, whose failure it is, the record that showed it, what changed, and the round's update or reset. `scripts/check-expectations.mjs` checks the file's shape, and a report goes out only when it passes. The verdict includes the log.
- A round is one pass through the whole prompt sequence. After a Reset the next round starts from the first prompt. After an Update the workspace still holds what the prompts built, so the Builder re-grades every line on it and sends only the prompts whose lines failed, plus any new one. Slips are re-prompted at once. Other faults are logged and the round runs on, unless the child is blocked, which ends the round. At the round's end the Builder applies every logged fix, then does one check, one save and one refresh, a reset if any fix needs one.
- Two fixing rounds in a row that turn no failing expectation into a pass mean stop: show the author the `## Fixes` log and ask. That rule, not the Test Project's Bifrost budget, is what ends a runaway loop; the Builder's patience with a hung child is prompt text.
- A Test Project in `failed` status is a pod fault, never the Template's. `tp.sh` retries it once through a restart; a second failure is reported as a pod that could not start, most likely for node capacity, and the Builder stops.

## Considered options

- **A Test Project per eval prompt.** Rejected. It buys isolation from a contamination that is the realistic condition, and pays a cold create for each prompt: a Custom Agent keeps no warm pool ([ADR-0041](0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md)).
- **A fresh opencode session per prompt in one Test Project.** Rejected. Those sessions are invisible to the status watcher and to the 1:1 Project↔session model, for a fresh context the Project boundary already gives.
- **In-pod testing only** (the `subagent` tool, the pod's own `:4096` API, or `opencode run`). Rejected, though far cheaper. The child would share the Builder's workspace and write over its files, and it would test a prompt rather than a delivered agent: the skills folder, the App contract and delivery would go unexercised.
- **Checking a Template only statically before saving, and letting the Test Project's first boot be the real check.** Rejected. The child repairs what it finds broken, so the test passes while every real Project gets the broken files.
- **Running the Builder's checks inside `template/`.** Rejected. Builds would write into the folder being saved, and a save would answer 409. The check runs on a copy.
- **Copying a fix into the Test Project through the shell**, as base64 arguments or an upload followed by a move. Rejected. One argument is capped at 128 KiB, and the copy can drift from what was saved. The backend's Update lays the saved version byte for byte.
- **The Test Project mechanics as shell recipes in the test-loop reference.** Rejected. The Builder retyped them every chat, each shell call lost the variables the last one set, and nothing tested them.
- **A mandatory clean run before the Builder says it is done.** Rejected. It costs another full round for every Agent, while the verdict already names each line that passed only after an update, and the author can ask for a reset run.
- **A dedicated `.checks/` folder for the child's screenshots.** Rejected. It needs its own `.gitignore`, save-list and init-container entries, which `/workspace/.cache/checks/` already has.
- **A timed TTL on Test Projects.** Rejected. A reaper protects human work, and its hard questions (opt-in, warnings) don't belong to a test loop.
- **A smaller Bifrost budget tier for Test Projects.** Rejected. A Test Project gets the ordinary default, and a Reset gives it a fresh one as a new Project would get.
- **A `steps` cap on the agent under test.** Rejected. Changing the definition in order to test it brings back the fidelity gap the real Project closes.
- **A stored eval suite** (expectations as rows, recorded runs, pass rates). Rejected. It is a product of its own, and nothing else consumes it.
- **A with/without-Skill benchmark.** Rejected. It needs a comparison surface and an opinion about what "better" means, and an author's first question is whether the Skill works at all.
- **Human-triggered testing, or propose-and-confirm.** Rejected. Both put the author back in the position of remembering to check.

## Consequences

- A test pays one cold create per chat, tens of seconds; later rounds pay an Update or a Reset instead.
- A runaway loop can spend a full project budget per Reset before the round rule stops it. The backend has no rate limit.
- `projects.created_by` and `projects.created_by_project_id` record who owns a Test Project and which chat made it. The second is what the 409, both refreshes and the reach predicate key on.
- The boot check misses only what create itself does: the init container's `.gitignore` merge, the first commit and preview routing.
- The fidelity gaps, which the Builder states when they matter: a Test Project is always cold; its spend lands on the Organization like any Project and appears in Admin storage; the external services the child calls are the real ones; and it reports on the definition as of its last refresh, so after an Update its conversation is not a clean start.
