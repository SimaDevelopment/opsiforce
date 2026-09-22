---
kind: explanation
adrs: [0024, 0030]
---

# Agent Updates

> How are existing project workspaces brought in line with a newer Agent profile without waiting for a pod restart?

## How it works

### Scope

- Two things travel through the pipeline: image-owned files (OpenCode config, the package prompt, the package's skills) and workspace migrations, one-shot scripts applied once per [Project](../../CONTEXT.md) and guarded by managed checksums so a user or Agent edit is not overwritten.
- Image-owned files are rewritten against an ownership list, so anything the backend wrote into the same directory survives: `opencode.json` is rebuilt from the image file by allow-list, keeping `default_agent` and every `agents.<slug>` block the package does not ship, and `agents/<package>.md` is the only prompt touched ([Agent](agent.md)).
- Of the skills, only the names the ledger records as `ownedSkills` are rewritten, or deleted when a newer image drops them. A workspace whose ledger predates that field adopts everything then present in `skills/` as owned, once.
- A workspace's first boot lays the package from the image in its init container and writes the ledger last; every later pod start finds the ledger and touches nothing, so the sweep is the only way built-in content reaches an existing workspace ([Agent](agent.md)).
- The Job has two modes. `content` rebuilds the config, the package prompt and the owned skills and stamps the ledger; it runs on **every** [ProjectEnvironment](../../CONTEXT.md) of the Project and can never ask for a pod recreate. `full` is `content` plus the workspace migrations and runs on **Development only**: migrations edit the app tree, which a published environment receives from Development through git, so applying them there would diverge the tree and the next publish would undo them ([ADR-0024](../adr/0024-agent-opencode-config-lives-in-the-workspace-opencode-dir.md), [ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- Two versions are distinct: the agent image tag in `agent-config/agent-image-version.json`, bumped on any image rebuild, and each Agent's template `version` in `agents.json`, bumped only when behaviour changes. A Built-in Agent's Project is current when the ledger's `contentVersion` matches that Agent's `version`; a Custom Agent's Project runs the image's `custom` package, whose content changes only when the image does, so its content version **is** the image version.

### Trigger and flow

- The only trigger is backend bootstrap: one BullMQ sweep reads every ProjectEnvironment that is not `pending` or `claiming`, resolves the package it runs (the Agent's name for a Built-in Agent, `custom` otherwise) and that package's content version, compares it with the workspace ledger's `contentVersion`, and enqueues one job per environment behind — `full` for Development, `content` for every published environment — with stable job ids deduplicating concurrent enqueues.
- An environment the sweep finds behind gets a `pending` row straight away, before its job runs, so a pod already resumed on a newer image is visible as behind rather than quietly serving the previous content.
- Each environment job re-checks the ledger, then runs a short-lived Kubernetes Job from the agent image that rewrites the image-owned files, applies pending migrations when the mode is `full`, writes the new ledger and reports a summary — owned skills written and removed, whether the config changed, migrations applied — which the backend records on the `project_agent_updates` row.
- A Built-in Agent's Project whose Agent carries no `version` on its `agents` row, which is what a slug retired from the merged registry leaves behind, is skipped and logged.

### One writer per environment

- The Job is not the only writer in `.opencode/`: adding, removing or re-pinning a Skill on a Built-in Agent fans out to every [ProjectEnvironment](../../CONTEXT.md) of that Agent in the Organization ([ADR-0059](../adr/0059-skills-exist-only-as-published-versions-and-a-built-in-agents-skills-live-on-a-development-profile.md)). Both writers are backend-initiated, and a `project_agent_updates` row with status `running` is the durable claim on that environment — not an in-memory lock, so it survives a backend restart.
- A Skill delivery that finds a `running` row for its environment **defers**: it re-queues itself and writes nothing. On a Built-in Agent's Project the processor runs the Skill reconcile itself, inside the claim, before releasing the row, so the Job and the reconcile land as one unit.
- Because a killed process would otherwise leave a `running` row claiming an environment for good, stale rows are reaped once on boot — by the Agent-Updates bootstrap hook and, independently, before the first Skill delivery of the process. The backend dying does not stop the Kubernetes Job, so the bootstrap reaper looks each stale row's Job up by its `opsiforce.io/agent-update-id` label first: a row whose Job still runs keeps its claim and has its clock restarted, and only a row with no writer behind it is failed.

### Reload

- OpenCode v2 watches `/workspace/.opencode/` and rebuilds config, agents, skills and plugins within about two seconds of a write made through the local kernel ([ADR-0030](../adr/0030-agent-owned-file-changes-need-no-opencode-reload.md)). Its watcher is inotify, which raises no event on a node that did not perform the write, so a writer on another node asks `agent-control` for `POST /notify-config-change` — a marker created and deleted under `.opencode/`, `.opencode/agents/` or `.opencode/skills/`, one place per reload path — and then confirms the result through the pod's `:4096` proxy before reporting success ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- Template changes a running pod cannot absorb (package manager, lockfile, build system) and anything baked into the image or pod spec declare `requiresPodRecreate: true` in their `migration.json`, and the pod is recreated ([Pod Lifecycle](../runtime/pod-lifecycle.md)). A migration is the only thing that can ask for one, so a `content` run never costs a user their session.
- An empty `requiresPodRecreate` migration is the lever for shipping a new baked binary or library, since a version bump alone reloads files in place ([App Readiness](../projects/app-readiness.md), [Document Generation](document-generation.md)).

## States

Row statuses on `project_agent_updates`.

| State | What happens |
|---|---|
| `pending` | The sweep has found the workspace behind; its Job has not started |
| `running` | The Kubernetes Job is applying files and migrations |
| `reload_pending` | Files applied; a pod recreate is deferred and retried on a backoff schedule |
| `applied` | The workspace is at the target version |
| `conflict` | A managed-checksum mismatch; the edited file was left alone |
| `failed` | The Job did not return cleanly; terminal |

## Edge cases

- When a session is busy or a transient error occurs, a pending pod recreate is deferred, and the next idle Agent request retries it opportunistically.
- Unclaimed pool slots are skipped by the sweep because the migration Job would mount the workspace the live pool pod is using ([Pending project pools](../runtime/pending-project-pools.md)).
- Any image rebuild moves every Custom Agent Project's content version, so each receives one `content` job even when only a built-in prompt changed. That is a few file copies against a hash-skipped config write, and it is preferred over inventing a non-agent entry in the registry file the reconciler, pool, picker and public API all read as "the agents".
- Outstanding and failed rows are shown per environment in Admin's Pods view, beside the Skill-delivery state ([Admin](../organization/admin.md)).

## Code

- `backend/src/agent-update/` — the boot sweep, per-Project processor and Kubernetes Job launcher.
- `backend/src/delivery/skill-delivery.service.ts` — the other writer in `.opencode/`: the Skill fan-out, its deferral on a `running` row and its activation check.
- `proxy/cmd/agent-control/notify.go` — the in-pod `POST /notify-config-change` handler.
- `agent-config/scripts/agent-workspace-migrate.mjs` — the in-pod script that rewrites the files it owns, applies migrations and writes the ledger.
- `agent-config/agents/app-builder/migrations/` — app-builder's migration directories and their manifests.
- `agent-config/agents.json` — the template `version` per Agent.

## Related

- [Agent](agent.md) — the profile and how the init container seeds a fresh workspace.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — what a pod recreate entails.
- [Document Generation](document-generation.md) — a rollout that needed both a version bump and a recreate.
