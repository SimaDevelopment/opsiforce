---
kind: explanation
terms: [Call log, Usage (External Service)]
---

# Call log

> What does the platform record about each call to or from an External Service, how long is it kept, what does Usage count, and who reads either?

## How it works

- The [Call log](../../GLOSSARY.md) is `external_service_calls`, one row per Call, written only by the [Gate](gate.md), the form and hook paths, the webhook front door and the doorbell, as one best-effort insert after the call. A row's `kind` is `operation`, `form`, `hook`, `inbound` or `delivery`, and its `id` is the `callId` the service and the caller saw.
- A row records `via`, the service (reference, slug text and manifest hash), the service environment that answered, the Organization, Project (with its title as text) and ProjectEnvironment, the Operation, callback, hook or Event types in `operation`, its kind, the Gate's `decision`, `status`, `code`, a `detail` of at most 500 characters checked for sent secrets, the labelled bound values touched, input and output sizes, duration and, for a form call, the editor. Bodies, headers and `context` are never stored, and every reference nulls out when its row is deleted.
- Rows live for `EXTERNAL_SERVICE_CALL_LOG_RETENTION_DAYS` days (default 30): a daily BullMQ job, `external-service-call-log-cleanup`, deletes older rows 1000 at a time and leaves Usage untouched.
- [Usage (External Service)](../../GLOSSARY.md) is `external_service_usage`, one row per Organization, Project, environment, service and month, kept for good. The Gate's Call write adds to it in the same transaction: every Operation Call counts in `calls`, a refused one also in `refused`, and one the Gate let through that answered 4xx or 5xx also in `failed`; each Event newly stored in a receiving environment counts one in `events` there. Form calls, hooks, deliveries and inbound requests count nothing, and there are no quotas.
- Five readers page the log newest first, 25 a page by a Newer/Older cursor, searchable by Operation or bound value and filtered by Allowed, Refused or Failed. Every reader but the calling agent's names the service environment that answered each Call (`servedBy`, shown as "Served by <environment>"; none for a built-in):

| Reader | Sees | Route | Needs |
|---|---|---|---|
| Anyone who can open the Project | one ProjectEnvironment's Calls to one service, in its Project configuration dialog | `projects/…/services/<serviceId>/calls` | nothing more |
| Organization admin | the Organization's Calls, each named with its service's slug, and monthly Usage, under Admin, Usage | `admin/calls`, `admin/usage` | `can_view_external_services_usage` |
| Custom service owner | its Custom External Service's Calls, on the service page | `services/<id>/calls` | `can_manage_tenant_external_services` |
| Platform operator | a built-in's Calls across Organizations, inbound ones included | `platform/services/<id>/calls` | `can_manage_platform_external_services` |
| The calling agent | its own ProjectEnvironment's Calls to one service | `agent/<slug>/calls` | its `service` key |

- Usage is bound to the authenticated tenant; its Organization reference is durable while the Project and environment references null out on delete, so history survives a deleted Project ([Admin](../organization/admin.md)).

## Edge cases

- When the Call insert fails, the call's answer still goes out and the failure is logged.
- When a hook Call is written after its service row was deleted, the insert fails its reference and is only logged.
- When a repeated Event is ignored by the store, Usage counts nothing for it.
- When a custom service is deleted, its Calls stay with no service reference.

## Code

- `backend/src/external-services/gate/call-log.ts` — the one Call writer and its Usage increment.
- `backend/src/external-services/calls/` — the readers and the retention job.
- `backend/src/external-services/usage/` — the Usage service and the Admin routes.
- `frontend/src/components/external-service/calls-table.tsx` — the one Calls table every reader renders.

## Related

- [Gate](gate.md) — the calls that write most rows.
- [Event](events.md) — inbound and delivery rows, and the Events Usage counts.
- [Admin](../organization/admin.md) — the Usage page.
- [Permissions](../organization/permissions.md) — the permissions in the readers' table.
