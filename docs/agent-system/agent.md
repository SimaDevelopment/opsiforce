---
kind: explanation
terms: [Agent, Agent Model]
adrs: [0008, 0032]
---

# Agent

> What defines an Agent, how its files reach a project workspace, and where its model and model catalog come from?

## How it works

### Profile and registry

- An [Agent](../../CONTEXT.md) is a profile under `agent-config/`, baked into the agent image: an `agent.md` definition with system prompt, skill overrides, a starter template, and a registry entry in `agents.json` carrying its [Agent Model](../../CONTEXT.md), OpenCode variant, [pool](../runtime/pending-project-pools.md) size and template version.
- The `agents` table is derived from the registry at backend boot by a reconciler keyed by slug: a new slug is inserted with a fresh id, an existing slug keeps its id and picks up a display-name change, and a slug absent from the registry is left untouched so retired Agents' [Projects](../../CONTEXT.md) keep resolving ([ADR-0008](../adr/0008-agent-model-owned-by-agent-config.md)).
- Agents that ship only in the full distribution live under `agent-config/private/` with their own registry fragment; the reconciler, the image build and every registry consumer merge that fragment over the public registry, and the standalone mirror carries an empty stub fragment in its place.

### Reaching a workspace

- The image stages every Agent under `/opt/agents/` with a self-contained `skills/` directory composed at build time as the shared pool `agent-config/skills/` plus the Agent's overrides, an override replacing a shared skill of the same name.
- At pod start an init container reads `AGENT_NAME` and lays the profile onto the workspace: the definition to `/workspace/.opencode/agents/`, skills to `/workspace/.opencode/skills/`, the shared OpenCode config with model and variant injected to `/workspace/.opencode/opencode.json`, and the starter template only when `/workspace/app` does not exist yet.
- `.opencode` sits at the highest file-config precedence, so the platform's model, providers and permissions win over any config a project's repo ships ([ADR-0024](../adr/0024-agent-opencode-config-lives-in-the-workspace-opencode-dir.md)); agent-owned files are refreshed on every pod start and by [Agent Updates](agent-updates.md), while the template is project-owned after creation.

### Model and catalog

- app-builder runs `openai/gpt-5.6-sol` with OpenCode's `high` variant; the model is a property of the profile, uniform across tenants, and changing it is a rollout, not a setting ([Defaults](../organization/defaults.md) hold timeouts and budgets only).
- The model picker's list is `agent-config/models.json`, a hand-maintained catalog in the models.dev shape holding only our providers and models, made the exclusive catalog through `OPENCODE_MODELS_PATH` with the runtime models.dev refresh disabled ([ADR-0032](../adr/0032-model-catalog-is-a-file-in-the-agent-image.md)).
- Adding a model means copying its models.dev record into `models.json` and adding its reasoning variants to `opencode.json`; the built-in OpenCode Zen provider is switched off by a plugin directive.
- OpenCode's built-in `build` agent is disabled and `plan` is kept read-only, so app-builder is the only build-capable Agent.

### Skills and template

- Skills are OpenCode's on-demand instructions: the Agent sees each skill's name and description and loads the full `SKILL.md` only when a task matches; the shared pool holds UI-neutral skills and app-builder overrides the UI-coupled ones.
- New app-builder Projects start from the template under its profile, a React, Tailwind and shadcn/ui frontend with a NestJS and `bun:sqlite` backend, shipped without `app.meta.json` so the Agent's first build writes it as the [Go-live](../../CONTEXT.md) step ([App Readiness](../projects/app-readiness.md)).

## Code

- `agent-config/` — profiles, the registry, the shared OpenCode config, the model catalog, the shared skill pool and the build scripts.
- `agent-config/scripts/compose-skills.mjs` — build-time composition of each Agent's skills.
- `agent-config/scripts/merge-registry.mjs` — build-time merge of the public and private registries.
- `backend/src/agent/` — the merged registry reader and the boot reconciler.
- `backend/src/pod/pod.template.ts` — the init container that lays the profile onto the workspace.
- `docker/Dockerfile.agent` — stages the Agents and the catalog into the image.

## Related

- [Agent Updates](agent-updates.md) — keeping existing workspaces aligned with a newer profile.
- [App Readiness](../projects/app-readiness.md) — Go-live detection of the file the template omits.
- [Defaults](../organization/defaults.md) — what tenants can tune, which excludes the model.
- [Pending project pools](../runtime/pending-project-pools.md) — the per-Agent pool size.
