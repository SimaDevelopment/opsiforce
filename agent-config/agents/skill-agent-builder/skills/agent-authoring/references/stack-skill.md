# Authoring a stack Skill

A stack Skill is the know-how that keeps every Project of an Agent the same shape as it grows: what
the Agent's Template does not show by itself — a capability on top of `web-app`, or the conventions of
another stack. The files a Project starts from are the Template's, never the Skill's.

The Built-in stack skills are the model to copy: `sqlite`, `nestjs-api` and `data-fetching` each settle
one part of the stack with decisions, conventions and short examples, and none of them holds an App's
code. Read one with `GET /skills/{id}` and its latest Version's files before you draft; your pod does
not carry them. The Agent's body still holds the Architecture and names the Skill; the Skill holds the
detail behind it. `skill-authoring` has the draft → validate → publish loop.

## What it holds — the frame

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
  passes, paced as below. The child runs them before it reports; your test run reads its record of
  them and re-runs one.

Write the decision every time: "use best practices" decides nothing.

## How often the checks run

Pace the definition of done the way `web-app` paces App Builder's, which is proven: checks run after
something is implemented, and they cover what was implemented.

- **After every change** — the stack's quick gates: build, type check, and the contract checker when it
  takes seconds. The `platform` skill's boot check and browser walk follow; name them, never restate them.
- **Before go-live** — the same, plus one walk of every page or entry point the App has.
- **Never in a child's turn** — restarting or recreating the pod, simulating production by hand, a
  crawl of every link, a full audit on every edit. Your test run covers those once, and a user waiting
  on a one-line change should not pay for them.

Tell the body to run the definition of done as the Skill paces it, never "the complete" one.

## What it never holds — an implementation

No components, endpoints, modules or skeleton files for the child to copy into `app/`. Files every
Project starts with go in the Template, where you test them before saving and each Project owns its
copy; code kept in a Skill lives outside git, untested, and goes stale the day a library moves.

The files a Skill carries are ones the child **reads or runs**, never ones the App ships:

- `references/*.md` — a long contract, a full style guide, anything the body points at;
- `scripts/` — tools the agent runs: a validator for a contract, a checker a definition-of-done line
  calls. Never a module the App imports or a file it copies.

Keep the whole Skill in kilobytes. Before publishing, read the tree once more: a file that would end up
in `app/` belongs in the Template or nowhere.

## A checker is optional

A Skill whose contract is exact enough to check — a file's columns, a format, where state lives — may
ship a checker in `scripts/`, printing one PASS or FAIL line per decision and exiting non-zero on a
failure. It reads and never writes: a checker that repairs is an implementation. Its definition-of-done
line says when it runs — after a change that could move what it checks, not after every edit.
