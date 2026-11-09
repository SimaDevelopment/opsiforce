---
kind: explanation
terms: [Inactivity cleanup]
adrs: [0108]
---

# Inactivity cleanup

> How does a [Project](../../GLOSSARY.md) nobody uses get disabled and later deleted on its own?

## How it works

- Each Project carries two optional [Inactivity cleanup](../../GLOSSARY.md) counts, Disable after and Delete after: durations in hours or days, from 1 hour to 3650 days, stored in milliseconds like the idle timeouts; empty means never, and Delete after must be longer than Disable after when both are set.
- A new Project copies the counts once, as a pair: its [Agent](../../GLOSSARY.md)'s own pair when there is one, otherwise the [Organization](../../GLOSSARY.md)'s default; create, a pool claim, import and duplicate (which copies the source Project's counts) all do this, and later changes to the Agent or the default never reach existing Projects ([ADR-0108](../adr/0108-inactivity-cleanup-is-copied-into-each-project-from-its-agent-or-organization-and-counted-from-keep-alive-activity.md)).
- The platform default seeds each new Organization's default like the other [Defaults](../organization/defaults.md); both are empty unless someone sets them.
- An Agent's own pair lives where its [Resources](../runtime/resources.md) do: a Custom Agent's in `agent_inactivity_cleanup`; a Built-in Agent's in `tenant_agent_inactivity_cleanup` for one Organization, else its platform pair in `agent_inactivity_cleanup`. A row means that layer decides, so a row with both counts empty means never even when the Organization has a default; no row means the next layer down decides. `agents.json` carries no counts.
- The Agent Settings dialog shows the pair as a choice between Inherited, naming where it comes from ("Organization default" or "Set for all organizations") with its counts, and Custom, for Custom and Built-in Agents alike; on a Built-in Agent the section reads "Inactivity cleanup in this organization". `PUT /agents/:id/inactivity-cleanup` patches the counts sent over the pair in force and saves it as the Agent's own (a Built-in Agent's for the caller's Organization); `DELETE` returns to the inherited pair. Both need `can_manage_agents` (a Custom Agent's editor for a Custom Agent), and each count needs `can_disable_project` or `can_delete_project`, `DELETE` both.
- On a Built-in Agent's Settings, `can_manage_platform_defaults` also sees "Inactivity cleanup for all organizations", choosing None (each Organization uses its own default) or Custom, which sets its platform pair through `PUT` and `DELETE /defaults/global/agents/:id/inactivity-cleanup`.
- An Agent's Duplicate, Export and Import carry its own pair, or a Built-in Agent's pair for this Organization, only when the copier holds both `can_disable_project` and `can_delete_project`; otherwise the copy follows its Organization's default, as does an export made before the counts existed ([Agent copies](../agent-system/agent-copies.md)).
- A Project's last activity is the latest `last_active_at` of its environments, written by every kind of [Keep-alive activity](../../GLOSSARY.md) and by every pod wake (scheduled runs, webhooks, incoming email) and pod startup, or its creation time when no environment ever ran; Enable writes it too, so a re-enabled Project starts a fresh count.
- An hourly job (`project-inactivity-cleanup` queue, at minute 17) first deletes every ordinary Project idle past Delete after, then disables every enabled one idle past Disable after, through the same delete and Disable (Project) a user runs ([Environments](environments.md)); it checks each Project again right before acting on it, so one used while the job is still working through its list is left alone.
- Only ordinary Projects (no `kind`) with an Organization are swept; Builder chats, Test Projects and pool slots never are.
- Every form shows each count as a switch with an amount and an Hours or Days unit, switched off meaning never, and says which kinds of activity keep a Project alive. Minutes are not offered: the hourly job acts up to an hour after a count runs out, so a count shorter than an hour would not mean what it says.
- The Project Settings Cleanup tab shows and edits the counts with the last activity and the dates they lead to, warns when saving would disable or delete the Project within the hour, and asks for confirmation before a save that deletes it; changing Disable after needs `can_disable_project` and Delete after needs `can_delete_project`, on the API as in the tab.
- A Project card in the sidebar names its next step, "Disables …" or "Deletes …", once that step is 7 days away or less.

## Edge cases

- When a Project is idle past both counts, it is deleted without being disabled first.
- When a disable or delete fails for one Project, the job logs it and goes on with the rest; the next run retries it.

## Code

- `backend/src/project/inactivity-cleanup.ts` — the step table (each step's count, permission, sweep order and action) every other part loops over, the counts' validation, the Agent's own, platform and Organization layers with their reads and writes, and the last-activity expression.
- `backend/src/project/inactivity-cleanup.processor.ts` — the hourly sweep.
- `frontend/src/components/inactivity-cleanup-fields.tsx` — the two switched counts shared by Defaults, Agent Settings and Project Settings, and the inherited-or-Custom choice the Agent Settings dialog shows for the Organization's and the platform's pair.
- `frontend/src/lib/inactivity-cleanup.ts` — the step table's wording and permissions, and the dates a Project's counts lead to, shared by the Cleanup tab and the Project card.

## Related

- [Environments](environments.md) — what disable and delete do to a Project.
- [Defaults](../organization/defaults.md) — the platform and Organization tiers the counts start from.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — the idle timeouts, which suspend a pod rather than the Project.
