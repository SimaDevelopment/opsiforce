---
kind: explanation
terms: [Resources, Resources preset]
adrs: [0005]
---

# Resources

> How is a [Project](../../GLOSSARY.md)'s pod size chosen, stored and applied to its environments?

## How it works

- [Resources](../../GLOSSARY.md) is a Project-level policy: one [Resources preset](../../GLOSSARY.md) or Custom numbers apply to every pod the Project runs, [Development](../../GLOSSARY.md) and published environments alike ([ADR-0005](../adr/0005-pod-class-project-level-snapshot.md)).
- The Project's row names its preset (`preset_id`, null for Custom) and holds the numbers its pod runs at. Picking a preset copies the Organization's current numbers for it into the row; Custom stores the typed numbers clamped to the Custom bounds. The pod builder reads only those numbers.
- Presets are rows in `resource_presets`: platform presets have no `tenant_id` and are offered to every Organization; an Organization's own presets carry its `tenant_id` and are offered only to it. `tenant_resource_preset_overrides` holds an Organization's own numbers for a platform preset. The pickers on the Project's and the Agent's Settings list the caller's Organization's presets, its numbers applied, served by `GET /pod-classes` with the default marked.
- The default preset is the platform's (`is_default`), or the Organization's own choice in `tenant_settings.default_resource_preset_id`. A Project starts at the default when its Agent has no Resources of its own.
- Settings, Resources manages them. With `can_manage_platform_resources` it shows the platform presets (add, edit, make default, delete) and a table of every Organization with its default, own presets and own values; each row opens that Organization's view. With only `can_manage_tenant_resources` it shows the caller's own Organization: its default, every preset it sees, its own presets (add, edit, delete) and its own values for platform presets (set, edit, use platform value) ([Permissions](../organization/permissions.md)).
- A numbers change asks how to apply. **New Projects only** writes the preset and nothing else. **Apply to all** also rewrites every Project on that preset in scope whose numbers differ and restarts its running pods three seconds apart through the `resource-preset-restart` queue; a platform preset's scope is every Organization without its own numbers for it. Custom Projects are never touched, and a sleeping pod starts at its row's numbers on its next wake.
- Each preset row counts the Projects on it still running at older numbers, after a New Projects only save or a change of an Organization's own value. **Apply to all Projects** in the row's menu moves them all to the preset's current numbers and restarts the running ones, the same as Apply to all at save time (`POST /resource-presets/…/:id/apply`).
- Deleting a preset turns every Project and Agent on it into Custom at the numbers it ran at; nothing restarts. The platform default cannot be deleted while it is the default.
- Changing one Project's Resources writes its row and nothing else; the new size materialises when the pod is next created, on an idle resume or through the Restart to apply action shown after a change, which targets the [Active environment](../../GLOSSARY.md).
- A new Project, including one claimed from the [pending project pool](pending-project-pools.md), starts at its Agent's Resources, with a preset's numbers from the Project's own Organization, copied once so a later change to the Agent or the preset reaches no existing Project unless someone applies to all ([ADR-0093](../adr/0093-an-agent-sets-the-resources-and-ready-projects-of-the-projects-created-from-it.md)). An Agent's Resources are, in order: for a Built-in Agent, the Organization's own choice (`tenant_agent_pod_settings`), then the platform's (`agent_pod_settings`); for a Custom Agent, its own row; otherwise the default preset.
- Duplicating a Project copies its own Resources. Importing one, or an Agent, takes the importing Organization's preset with the carried name, or Custom at the carried numbers when it has none.
- Every preset change asks the pool to check its Ready Projects; a slot whose numbers no longer match what its Agent would get is recycled.
- Gated by `can_manage_project_pod_settings` on the Project's Resources tab and its endpoint. An Agent's Settings (`PUT` and `DELETE /agents/:id/pod-class`) need `can_manage_agents`: a Custom Agent's write its own row, a Built-in Agent's write this Organization's choice, and `DELETE` returns to the platform's choice or the default. On a Built-in Agent's Settings, `can_manage_platform_resources` also shows its Platform value, the preset every Organization without its own choice gets (`PUT /resource-presets/platform/agents/:agentId`).

## Edge cases

- When one Project's Resources changes while other environments are running, each adopts the new size on its own next restart or resume.
- Apply to all interrupts chats in progress on the pods it restarts; the confirmation shows the Projects and running pods on the preset first.
- An Organization with its own numbers for a preset, or its own choice for a Built-in Agent, never claims that Agent's Ready Projects built at the platform's numbers; its new Projects wait for a fresh pod.
- Presets and Custom share one range, from 0.05 vCPU / 0.5 GiB up to the cluster's maximum, with the memory limit at least the request, so a deleted preset's numbers are always valid Custom numbers. A name is at most 40 characters, unique in its scope, and never "Custom".
- The maximum is per deployment: the backend Helm value `config.agentMaxResources` (`AGENT_MAX_CPU_MILLICORES`, `AGENT_MAX_MEMORY_REQUEST_MIB`, `AGENT_MAX_MEMORY_LIMIT_MIB`), 4 vCPU / 16 GiB request / 24 GiB limit when unset. The memory request maximum should stay below the agent nodes' allocatable memory, or a pod at it never schedules; the limit may exceed it, since limits are not reserved. A value that is not a whole number, is below the minimum, or puts the limit below the request stops the backend at startup.
- Lowering the maximum changes no stored numbers: Projects keep running as they are, and a preset above it saves again only once brought within it. A Custom choice above it is clamped to it.

## Code

- `backend/src/pod/pod-classes.ts` — Resources types, the range and its per-deployment maximum, clamping and validation.
- `backend/src/pod/resource-presets.ts` — the presets one Organization sees, its default, and reading a stored choice or an export.
- `backend/src/resource-preset/` — Settings, Resources endpoints, apply to all, delete and the restart queue.
- `backend/src/agent/agent-pod-settings.ts` — an Agent's Resources in one Organization.
- `resource_presets`, `tenant_resource_preset_overrides`, `project_pod_settings`, `agent_pod_settings` and `tenant_agent_pod_settings` in `backend/db/schema.ts`.
- `frontend/src/pages/resources.tsx` — Settings, Resources.
- `frontend/src/components/resources/` — the Resources selector and its draft, shared by the Project's and the Agent's Settings.

## Related

- [Pod Lifecycle](pod-lifecycle.md) — why applying a size is always a pod recreate.
- [Pods](pods.md) — the preset shown per running pod.
