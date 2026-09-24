---
kind: explanation
terms: [Agent, Agent Model]
adrs: [0008, 0032]
---

# Agent

> What defines an Agent, how its files reach a project workspace, and where its model and model catalog come from?

## How it works

### Profile and registry

- An [Agent](../../CONTEXT.md) is a profile under `agent-config/`, baked into the agent image: an `agent.md` definition with system prompt, skill overrides, a starter template, and a registry entry in `agents.json` carrying its [Agent Model](../../CONTEXT.md), OpenCode variant, [pool](../runtime/pending-project-pools.md) size and template version. The public registry ships two: `app-builder`, the picker's default with a warm pool while the Organization has it enabled ([ADR-0072](../adr/0072-disabling-is-an-organizations-choice-recorded-beside-the-agent-or-skill.md)), and `skill-agent-builder` — the [Skill & Agent Builder](../../CONTEXT.md), `poolSize` 0 and `platformApi: true`, whose package carries the `skill-authoring` and `agent-authoring` skills and a template with no `app/`, so its pod idles with no App of its own ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md), [ADR-0063](../adr/0063-the-builder-tests-a-child-agent-by-conversing-with-it-in-one-throwaway-project.md)).
- The `agents` table is derived from the registry at backend boot by a reconciler keyed by slug, **within the global scope only** — the rows with `tenant_id IS NULL`, which is where Built-in Agents live: a new slug is inserted with a fresh id and `origin = 'built_in'`, an existing global slug keeps its id and has its display name, description, `version`, `model`, `variant` and `pool_size` mirrored from the registry on every boot, and a slug absent from the registry is left untouched, which withdraws it from the Agent picker, the public API's Agent list and project creation — the three surfaces that offer a Built-in Agent while its slug is in the merged registry, is not the [Skill & Agent Builder](../../CONTEXT.md) and the Organization has not disabled it, and a Custom Agent while it is enabled, visible to the caller and carrying an [Agent Profile](../../CONTEXT.md) at its Default environment (Agent) — while retired Agents' [Projects](../../CONTEXT.md) keep resolving their Agent by id ([ADR-0008](../adr/0008-agent-model-owned-by-agent-config.md), [ADR-0054](../adr/0054-built-in-and-custom-agents-coexist-by-scope.md), [ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)). A tenant's Custom Agent carrying the same slug is a different row and is never touched, and the mirrored `pool_size` and `version` are what the [pool](../runtime/pending-project-pools.md) and the [Agent Updates](agent-updates.md) sweep read — the registry file is the reconciler's input, not theirs.
- A second reconciler runs straight after it and before the Agent-Updates sweep is enqueued, minting the image's composed skill directories as [Built-in Skills](skills.md). A backend whose image ships no skill tree fails at boot rather than presenting an Organization with an empty catalogue.
- Agents that ship only in the full distribution live under `agent-config/private/` with their own registry fragment; the reconciler, the image build and every registry consumer merge that fragment over the public registry, and the standalone mirror carries an empty stub fragment in its place.

### Reaching a workspace

- The image stages every package under `/opt/agents/` with a self-contained `skills/` directory composed at build time as the shared pool `agent-config/skills/` plus the package's overrides, an override replacing a shared skill of the same name and a package able to leave a shared skill out (`makara-app-builder` composes without `web-app`, whose starter is not its own). A package is the image folder a pod boots from: each Built-in Agent has its own, and `custom` is the one every Custom Agent's Project boots from, carrying the composed shared skills and nothing else — no prompt, no template, no migrations ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- At a workspace's **first boot only** — when `/workspace/.opsiforce/agents/<package>.json` is absent — an init container reads `AGENT_NAME` and lays the package onto the workspace: the definition to `/workspace/.opencode/agents/`, skills to `/workspace/.opencode/skills/`, the OpenCode config rebuilt from the image file to `/workspace/.opencode/opencode.json` (carrying forward the `default_agent` the backend wrote and never inventing one), the starter template when `/workspace/app` does not exist yet, an empty `/workspace/app/` when the package ships no template, and `git init` when the workspace carries no repository. The ledger is written last, so its presence means the workspace provisioned successfully and a crashed first boot is simply retried.
- `.opencode` sits at the highest file-config precedence, so the platform's model, providers and permissions win over any config a project's repo ships ([ADR-0024](../adr/0024-agent-opencode-config-lives-in-the-workspace-opencode-dir.md)); image-owned files are laid once at first boot and refreshed only by [Agent Updates](agent-updates.md), while the template is project-owned after creation.

### Model and catalog

- app-builder runs `openai/gpt-5.6-sol` with OpenCode's `high` variant; the model is a property of the profile, uniform across tenants, and changing it is a rollout, not a setting ([Defaults](../organization/defaults.md) hold timeouts and budgets only).
- The model picker's list is `agent-config/models.json`, a hand-maintained catalog in the models.dev shape holding only our providers and models, made the exclusive catalog through `OPENCODE_MODELS_PATH` with the runtime models.dev refresh disabled ([ADR-0032](../adr/0032-model-catalog-is-a-file-in-the-agent-image.md)).
- Adding a model means copying its models.dev record into `models.json` and adding its reasoning variants to `opencode.json`; the built-in OpenCode Zen provider is switched off by a plugin directive.
- Both images carry that file: the agent image as the pod's exclusive catalog, and the backend image because agent create and profile save resolve their `provider/model` pair against it and the Store's Model and Effort selects are served from it. A backend whose image is missing the file, or whose copy is unparseable or declares no models, fails at boot rather than refusing every model later as an `Unknown provider` conflict.
- OpenCode's built-in `build` agent is disabled and `plan` is kept read-only, so app-builder is the only build-capable Agent.
- The permission ruleset allows everything and then denies three writes outright — under `.opencode/**`, under `.opsiforce/**`, and to `data/database.db` — so an Agent cannot rewrite its own configuration or the platform database; the last matching rule wins, which is why the denials follow the allow-all ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).

### Skills and template

- Skills are OpenCode's on-demand instructions: the Agent sees each skill's name and description and loads the full `SKILL.md` only when a task matches; the shared pool holds the skills every package composes (including `web-app`, which is coupled to the default stack), a package may exclude a shared skill it contradicts, and app-builder overrides the UI-coupled ones for its own tree.
- The [Platform Skill](platform-skill.md) `platform` is one of those shared skills, so every package ships it — `custom` included — and an Agent's own prompt never restates what it holds.
- New app-builder Projects start from the template under its profile, a React, Tailwind and shadcn/ui frontend with a NestJS and `bun:sqlite` backend, shipped without `app.meta.json` so the Agent's first build writes it as the [Go-live](../../CONTEXT.md) step ([App Readiness](../projects/app-readiness.md)). Everything true because of that template — the running dev servers, the build order, the structure, the rules — is the shared `web-app` skill, which app-builder's prompt loads and a Custom Agent on the same stack pins; its first step lays the template from `/opt/agents/app-builder/template/app` into an empty `app/` ([ADR-0068](../adr/0068-a-custom-agent-names-a-starter-and-the-web-app-know-how-is-a-skill-both-kinds-build-from.md)).

## Code

- `agent-config/` — profiles, the registry, the shared OpenCode config, the model catalog, the shared skill pool and the build scripts.
- `agent-config/scripts/` — the build-time steps: `compose-skills.mjs` composes each Agent's skills, `merge-registry.mjs` merges the public and private registries, and `generate-validate-skill.mjs` cuts the Builder template's offline validator from the backend's own gate sources so the two cannot drift.
- `backend/src/agent/` — the merged registry reader, the boot reconciler, and the Custom Agent routes over profiles, Skills, Publish (Agent) and settings.
- `backend/src/store/` — the Built-in Skill reconciler and the skill tree reader it boots from.
- `backend/src/delivery/` — the backend's workspace writer, the create and claim delivery, and the runtime agent resolver.
- `backend/src/pod/pod.template.ts` — the init container that lays the package onto the workspace; `AGENT_NAME` is the package, so `custom` for every Custom Agent's Project.
- `docker/Dockerfile.agent` — stages the Agents and the catalog into the image.

## Related

- [Agent Updates](agent-updates.md) — keeping existing workspaces aligned with a newer profile.
- [Custom Agents](custom-agents.md) — the Agents an Organization authors, and their per-Environment Profiles.
- [Dynamic Delivery](dynamic-delivery.md) — who writes which file in a workspace, and when a change arrives.
- [Platform Skill](platform-skill.md) — the shared skill every package carries and the App contract it holds.
- [App Readiness](../projects/app-readiness.md) — Go-live detection of the file the template omits.
- [Pending project pools](../runtime/pending-project-pools.md) — the per-Agent pool size.
