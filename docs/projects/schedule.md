---
kind: explanation
terms: [Schedule]
---

# Schedule

> How does an agent-registered cron job belong to one environment, fire against its App, and get managed from the UI?

## How it works

- A [Schedule](../../CONTEXT.md) belongs to one [ProjectEnvironment](../../CONTEXT.md) and fires only against that environment's running App; the agent registers it over the Service Gateway, whose token already identifies the calling environment ([Service Gateway](../gateways/service-gateway.md)).
- A [Publish](publish.md) copies the Schedules checked in the publish form into the target as independent copies, so a same-named Schedule can exist and fire in several environments; a name is unique only within an environment.
- Firing happens inside the cluster: the worker resolves the owning environment, wakes a suspended pod through the same path as a user opening the [Project](../../CONTEXT.md), waits for readiness ([App Readiness](app-readiness.md)), calls the App's endpoint and records an execution with status, latency and any error.
- Schedules fire in the Project's timezone, captured from the user's browser at creation and stamped on each Schedule.
- Agent-facing endpoints sit under the cluster-internal gateway prefix the edge blocks; human management requires `can_manage_schedules`, enforced at the controller class ([Permissions](../organization/permissions.md)).
- The tenant-wide Schedules page shows one tab per registry [Environment](../../CONTEXT.md), loading that tab's Schedules across every Project on demand, with edit, toggle, run now, history and delete.
- Opening Schedules from an environment's row in the Environments switcher shows the single project-environment view of the same page, filtered by that ProjectEnvironment, with an "All schedules" link back.

```
Agent in a pod
  └─ POST $SERVICE_GATEWAY_URL/schedules        (token ⇒ project + environment)
        ▼
  backend stores the schedule, owned by that environment
        ▼  cron fires (in the project's timezone)
  worker wakes the environment's pod if suspended, then
        ▼
  calls the app's endpoint ⇒ records an execution
```

## Edge cases

- When the owning environment is disabled or failed, the worker skips the call and records the reason as the execution.
- When a Project is duplicated or imported, its Schedules arrive paused ([Duplication](duplication.md), [Export and Import](export-import.md)).
- Without `can_manage_schedules`, the navigation entry, the per-environment launcher and the page itself disappear, and the page redirects home.

## Code

- `backend/src/schedule/` — agent-facing and admin endpoints, the BullMQ sync and the firing worker.
- `projectSchedules` in `backend/db/schema.ts` — Schedules keyed per environment, with `scheduleExecutions` beside it.
- `frontend/src/pages/schedules.tsx` — both views of the page.
- `agent-config/skills/schedules/SKILL.md` — how the agent registers a Schedule.

## Related

- [Service Gateway](../gateways/service-gateway.md) — the token Schedules authenticate with.
- [Environments](environments.md) — the switcher row the per-environment view opens from.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — the wake path a firing Schedule uses.
