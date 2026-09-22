---
kind: explanation
adrs: [0024, 0030]
---

# Agent Updates

> How are existing project workspaces brought in line with a newer Agent profile without waiting for a pod restart?

## How it works

### Scope

- Two things travel through the pipeline: agent-owned files (OpenCode config, the prompt, skills), replaced wholesale, and workspace migrations, one-shot scripts applied once per [Project](../../CONTEXT.md) and guarded by managed checksums so a user or Agent edit is not overwritten.
- A freshly created or reassigned pod copies the current profile from the image in its init container and writes a ledger entry at the current template version, so the sweep concerns only long-running pods started before a version bump ([Agent](agent.md)).
- The sweep targets [Development](../../CONTEXT.md) environments only; a published environment picks up current agent-owned files at its next publish-driven pod start, and migrations never run there ([ADR-0024](../adr/0024-agent-opencode-config-lives-in-the-workspace-opencode-dir.md)).
- Two versions are distinct: the agent image tag in `agent-config/agent-image-version.json`, bumped on any image rebuild, and each Agent's template `version` in `agents.json`, bumped only when behaviour changes and the sole source of "is this workspace current".

### Trigger and flow

- The only trigger is backend bootstrap: one BullMQ sweep reads every Project, resolves its own Agent through the merged registry, compares the workspace ledger under that Agent's name with that Agent's template version, and enqueues a per-Project job only for those behind, with stable job ids deduplicating concurrent enqueues.
- Each Project job re-checks the ledger, then runs a short-lived Kubernetes Job from the agent image that replaces agent-owned files, applies pending migrations, writes the new ledger and reports a summary the backend records on a `project_agent_updates` row.
- A Project whose Agent is missing from the merged registry is skipped and logged.

### Reload

- Agent-owned file changes need no reload call: OpenCode v2 watches `/workspace/.opencode/` and rebuilds config, agents, skills and plugins within about two seconds of a write, so writing the files is the reload ([ADR-0030](../adr/0030-agent-owned-file-changes-need-no-opencode-reload.md)).
- Template changes a running pod cannot absorb (package manager, lockfile, build system) and anything baked into the image or pod spec declare `requiresPodRecreate: true` in their `migration.json`, and the pod is recreated ([Pod Lifecycle](../runtime/pod-lifecycle.md)).
- An empty `requiresPodRecreate` migration is the lever for shipping a new baked binary or library, since a version bump alone reloads files in place ([App Readiness](../projects/app-readiness.md), [Document Generation](document-generation.md)).

## States

Row statuses on `project_agent_updates`.

| State | What happens |
|---|---|
| `running` | The Kubernetes Job is applying files and migrations |
| `reload_pending` | Files applied; a pod recreate is deferred and retried on a backoff schedule |
| `applied` | The workspace is at the target version |
| `conflict` | A managed-checksum mismatch; the edited file was left alone |
| `failed` | The Job did not return cleanly; terminal |

## Edge cases

- When a session is busy or a transient error occurs, a pending pod recreate is deferred, and the next idle Agent request retries it opportunistically.
- Unclaimed pool slots are skipped by the sweep because the migration Job would mount the workspace the live pool pod is using ([Pending project pools](../runtime/pending-project-pools.md)).

## Code

- `backend/src/agent-update/` — the boot sweep, per-Project processor and Kubernetes Job launcher.
- `agent-config/scripts/agent-workspace-migrate.mjs` — the in-pod script that replaces files, applies migrations and writes the ledger.
- `agent-config/agents/app-builder/migrations/` — app-builder's migration directories and their manifests.
- `agent-config/agents.json` — the template `version` per Agent.

## Related

- [Agent](agent.md) — the profile and how the init container seeds a fresh workspace.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — what a pod recreate entails.
- [Document Generation](document-generation.md) — a rollout that needed both a version bump and a recreate.
