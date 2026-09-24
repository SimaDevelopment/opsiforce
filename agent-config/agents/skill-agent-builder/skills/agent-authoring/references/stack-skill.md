# Authoring a stack Skill

A stack Skill is how every Project of an Agent comes out the same shape without the Skill holding
the App. It comes in two kinds with the same rules:

- **An addition to the starter** — a capability every App of the Agent has on top of `web-app`, loaded
  after it: a document editor with its exports, a booking flow, a domain's modules.
- **A scaffold** — `<agent>-scaffold`, for when the starter cannot fit: it describes the whole
  skeleton the child creates on the first build.

The Built-in stack skills are the model to copy: `ui`, `sqlite`, `nestjs-api` and `data-fetching` each
settle one part of the stack with decisions, conventions and short examples, and none of them holds an
App's code. The Agent's body still holds the Architecture and names the Skill; the Skill holds the
detail behind it. `skill-authoring` has the draft → validate → publish loop.

## What it holds — the frame

- **Structure** — the directories and key files, one line of responsibility each, and where a new
  feature goes.
- **Stack and libraries** — the language, the framework and each library by name, what each is for,
  and what is not used instead. No version pins: the child takes the latest stable release when it
  adds one, as the `platform` skill says. Say which major version the Skill's specifics were written
  against, so a child on a newer major knows to check what changed. A Node stack uses Yarn; the Skill
  decides once whether it runs under Plug'n'Play or, when PnP cannot be made to work with the stack,
  `node-modules`, and says why.
- **Contracts** — the data formats and schemas, the routes with their request and response shapes, the
  constants (sizes, limits, presets) and the names. A contract is exact: a type definition or a schema
  in a code block, the real numbers, never "a suitable format".
- **Style guide** — the conventions that should look the same in every Project: code style and naming,
  UI patterns, copy and tone, error handling, file size.
- **Runtime** — what `startup.sh` ensures and runs for this stack, named in the terms of the `platform`
  skill's rules: the runtime, each service, what the production branch builds. Named, not scripted.
- **Short examples** — a few lines showing how a library is used here or how a contract is met. An
  example illustrates; it is never the App's code.
- **Anti-patterns** — what goes wrong on this stack and must not happen.
- **Definition of done** — the checks that say a build is good, each a command and the answer that
  passes, paced as below. The child runs them before it reports, and your test run grades with the
  same ones.

Write the decision every time: "use best practices" decides nothing.

## How often the checks run

Pace the definition of done the way `web-app` paces App Builder's, which is proven: checks run after
something is implemented, and they cover what was implemented.

- **After every change** — the `platform` skill's boot check (name it, do not restate it), then the
  stack's quick gates: build, type check, and the contract checker when it takes seconds. Then walk
  the flow that changed in the browser.
- **Before go-live** — the same, plus one walk of every page or entry point the App has.
- **Never in a child's turn** — restarting or recreating the pod, simulating production by hand, a
  crawl of every link, a full audit on every edit. Your test run covers those once, and a user waiting
  on a one-line change should not pay for them.

Tell the body to run the definition of done as the Skill paces it, never "the complete" one.

## What it never holds — an implementation

No components, endpoints, modules or skeleton files for the child to copy into `app/`. Code kept in a
Skill lives outside git, untested, and goes stale the day the starter or a library moves — and a
Project does not need identical bytes to be consistent, it needs identical decisions. The child writes
the code against the contract every time; the contract is what makes it come out the same.

The files a Skill carries are ones the child **reads or runs**, never ones the App ships:

- `references/*.md` — a long contract, a full style guide, anything the body points at;
- `scripts/` — tools the agent runs: a validator for a contract, a checker a definition-of-done line
  calls. Never a module the App imports or a file it copies.

Keep the whole Skill in kilobytes. Before publishing, read the tree once more: a file that would end up
in `app/` is an implementation — replace it with the contract it was meant to satisfy.

## A scaffold creates its skeleton from the description

A scaffold's first step creates the skeleton its Structure section describes — `startup.sh` first, in
the shape the `platform` skill gives — and only into an `app/` that holds nothing but the platform's
`data/` and the App's configuration file, the same test `web-app` uses:

```bash
[ -z "$(ls -A /workspace/app | grep -vxE 'data|opsiforce\.env(\.backup)?\.json')" ]
```

Anything else in `app/` is someone's work: never create over it, and never again once the skeleton
exists — from then on the Project owns it and the Skill's rules govern how it grows.

## A scaffold ships a structure checker

A description alone does not hold a skeleton steady: one Project takes the Skill's package manager,
the next slips in a second one, and only reading the code shows it. So every scaffold ships
`scripts/check-skeleton.sh` — one line per decision its Structure and Stack sections make, printing
`PASS <decision>` or `FAIL <decision>`, and exiting non-zero when any line fails:

```bash
#!/bin/bash
cd /workspace/app || exit 2
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

check "uv project with a lockfile"     '[ -f pyproject.toml ] && [ -f uv.lock ]'
check "no second package manager"      '[ ! -e requirements.txt ] && [ ! -e package.json ]'
check "routes and templates in place"  '[ -d src/monitor/routes ] && [ -d src/monitor/templates ]'
check "migrations are numbered SQL"    '! ls migrations | grep -vqE "^[0-9]{4}_[a-z0-9_]+\.sql$"'
check "nothing outside the structure"  '[ -z "$(ls -A | grep -vxE "startup.sh|pyproject.toml|uv.lock|src|migrations|data|\.venv|app\.meta\.json|opsiforce\.env(\.backup)?\.json|\.git.*")" ]'
exit $fail
```

- It **reads and never writes** — no `--fix`, no file it creates. A checker that repairs is an
  implementation.
- It checks **the Skill's own decisions** — structure, stack, package manager, where state lives, the
  shape of its contracts' files. What the `platform` skill requires of `startup.sh` is proven by the
  restart in the test run, not re-checked here; whether a feature works is the browser's job.
- It runs **when the structure can have moved, not on every change.** Its lines are about structure,
  so only a structural change can fail one. The definition of done names it for three moments: right
  after creating the skeleton, after any change that adds or removes a package, a top-level file or a
  directory, and before go-live — *run `bash /workspace/.opencode/skills/<name>/scripts/check-skeleton.sh`;
  every line PASS.* A change inside existing files skips it. Your test run grades it after every
  prompt and after the restart regardless, so a child that skipped a moment it should not have is
  caught there.

An addition to the starter ships the same kind of checker when its contract is exact enough to check —
an export's columns, a file format.
