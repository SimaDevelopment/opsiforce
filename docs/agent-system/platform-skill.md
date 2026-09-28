---
kind: explanation
terms: [Platform Skill, App contract]
adrs: [0061]
---

# Platform Skill

> Where the facts every Agent needs about running here are written down, and why no Agent's prompt repeats them?

## How it works

### One place for the platform's facts

- The [Platform Skill](../../CONTEXT.md) is the built-in skill named `platform`. It ships in the shared pool, so every package composes it — `custom` included — and every workspace carries it, whatever Agent the Project runs: the image lays it on a Built-in Agent's Project, and on a Custom Agent's Project it is the pinned Skill delivery writes at create ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- It holds the rule that the agent does the work itself — the person in the chat never runs a command — and installs whatever a task needs as root in the sandbox; the [App contract](../../CONTEXT.md); the rule that the pod is disposable and the workspace durable — what a pod recreate wipes, that `startup.sh` is the one repeatable recipe that brings the App up from nothing — ensuring every runtime dependency idempotently, keeping state under `app/data/`, running every long-running process under `guard` in the foreground — and that Publish is a git checkout carrying code but no `data/`, so the App creates its own schema and seed data on boot. It also says to judge whether a service is running by asking the service rather than a pid file, that a server reconnects when a dependency restarts under it, and that only install lines are rerun by hand to check them. A toolchain the image lacks goes into `/workspace/.cache/<tool>-<version>`, which git ignores and every restart keeps, and whatever is installed or built under `app/` is listed in `app/.gitignore`, because Publish commits everything git does not ignore; a server that must be compiled builds inside its guarded command, so a restart runs current source, and runs under a watcher in development. It names no particular service; the rules are stated once for any stack. It also fixes Yarn as the package manager for every Node project (Plug'n'Play by default, `node-modules` only when PnP cannot work with the stack), and the dependency rule for any language: latest stable release when added, never a pre-release unless asked, then fixed by the lockfile with no unrequested major upgrades ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)) — where uploads and generated files live, `app/opsiforce.env.json` and what Publish does to it, the pod's environment variables, the LLM gateway with the ban on locally run models, and the two read-only platform databases with the queries that read them.
- It owns the definition of done for every stack: the boot and crash queries come back clean before a browser is opened, an Agent that carries `agent-browser` walks the flow it changed before calling it done, and every screenshot is saved under `/workspace/.cache/checks/`, which survives a restart and is never published. A stack skill such as `web-app` keeps only its own commands and points here for the walk.
- Nothing is prepended to an Agent's prompt. A Custom Agent's body is its author's words alone, and the delivery writer wraps it in frontmatter and nothing else, so there is no rendered composite anywhere to inspect ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- Because a skill is loaded on demand, a prompt that needs the contract says one line — *"Load the `platform` skill before you build, serve or deliver anything"* — and nothing more. A prompt that restates a platform fact instead freezes it at the moment its Project was created, which is the failure the split exists to prevent.
- Its name is reserved and it cannot be removed from an Agent's Skills, so no Agent can be authored without it.
- A change to it is an image bump and an [Agent Updates](agent-updates.md) `content` run, reaching every existing Project of a Built-in Agent with no pod restart — which is what makes the split cheap enough to be worth having. A Custom Agent's Project keeps the `platform` Version it was created with: the `content` run skips a Skill the backend delivered rather than the image, and a re-pin reaches only Projects created after it.

### The App contract

- Three things make an App: an executable `/workspace/app/startup.sh` the pod runs, restarts and re-runs in a published Environment; a server answering on `$APP_PORT`; and `app/app.meta.json` naming the App.
- Any HTTP answer on the port at any status counts as serving — no health route is required — and serving plus the meta file present is [Go-live](../projects/app-readiness.md).
- The starter template satisfies the contract out of the box and ships without `app.meta.json`, so a Built-in Agent's first build writes it. A Custom Agent's Project arrives with whatever its [Template](../../CONTEXT.md) holds; without one, the Agent writes all three files itself.
- A workspace with no `startup.sh` is not an error: the pod's wait loop idles quietly and the Project simply reports no App. The [Skill & Agent Builder](skill-agent-builder.md)'s own chat is exactly that case.

## Edge cases

- When `app.meta.json` already exists, an Agent leaves its `name` and `description` alone, because a user's edits are made from the platform and must survive the next build.
- When an Agent starts a server any other way than `startup.sh`, the process is unsupervised, dies with its shell and is never routed to.
- When the pod's permission ruleset is consulted, writes under `.opencode/**` and `.opsiforce/**` are denied outright, so an Agent cannot edit the skill that describes its own platform.

## Code

- `agent-config/skills/platform/` — the skill itself; the one place these facts are written.
- `backend/src/delivery/delivery.types.ts` — the frontmatter the writer wraps an author's body in, and nothing else.
- `backend/src/project/project.service.ts` — the Go-live read of `app/app.meta.json`.

## Related

- [Agent](agent.md) — the shared skill pool and how a package composes it.
- [App Readiness](../projects/app-readiness.md) — Go-live detection and the preview pane.
- [Dynamic Delivery](dynamic-delivery.md) — how a change to the skill reaches existing workspaces.
- [Custom Agents](custom-agents.md) — the prompt body the skill deliberately leaves empty of platform facts.
