---
kind: explanation
terms: [Call log, Usage (External Service)]
adrs: [0092]
---

# Call log

> What does an External Service record about each call it receives, how long is it kept, what does Usage count, and who reads either?

## How it works

- A service keeps its own [Call log](../../GLOSSARY.md); the platform keeps no record of the calls it forwards. Its SDK writes one row per request that carries a valid Caller identity into `data/service-records.db` in the copy's workspace when the answer ends, and deletes rows older than 30 days ([ADR-0092](../adr/0092-an-external-service-keeps-its-own-call-log-and-usage-and-the-platform-only-reads-them.md)). The file's schema, the outcomes (`proxied`, `handled`, `not supported`, `not allowed`, `failed`) and the journal rules are in `external-service-sdk/WIRE-CONTRACT.md`; the SDK's own *not connected* and *incomplete* refusals are rows with outcome `not allowed`.
- The backend opens that file read-only on a fresh connection per read and never writes to it. A read that meets a commit in progress or a torn page is tried up to five times within about half a second, then answered `503` with code `records-busy`; a file that is not a readable database is answered `502` with code `records-unreadable` and the copy's pod state; a missing file reads as no calls. No pod is woken to read it.
- The service page's Calls tab of a Custom service reads `services/<id>/call-log?copy=default|development` (`can_manage_tenant_external_services`); the Project configuration dialog reads `projects/…/services/<serviceId>/call-log`, the copy that serves that ProjectEnvironment (Development for the Test Project) and only its rows. Both page 25 newest first by a Newer/Older cursor, filter by outcome (Allowed covers `proxied` and `handled`; the row's detail says whether the upstream or the service itself answered), Project and time range (1 h, 24 h, 7 d, 30 d), name each caller's Project and environment ("Deleted project" when the Project is gone), and refresh their first page every 10 seconds while the tab is visible. A platform call (a form's choices, details or buttons, an after-save hook, a Publish probe) is listed only when it did not succeed, named by what it was doing ("Loading form choices"), so an admin finds why a form failed without the routine traffic.
- A service keeps its own [Usage (External Service)](../../GLOSSARY.md) in the same file: one total per UTC month, Project, ProjectEnvironment and counter, with the counter's label and description stored on the row, never pruned. The SDK adds `requests`, `not_allowed` and `failed` as it writes each `call` request's Call log row (`platform` requests count nothing); the service declares its own counters in `defineService({ counters })` (at most 20, snake_case names, labels up to 60 characters) and counts them with `ctx.count(name, n)` in a request or `service.count(name, n, { projectEnvironment })` outside one, where no ProjectEnvironment makes a Service row. An undeclared name or a count outside 1 to 10⁹ throws. Counts are display only.
- The service page's Usage tab reads `services/<id>/usage?copy=default|development&month=YYYY-MM` (`can_manage_tenant_external_services`, the Calls tab's permission): the months that hold data (newest first, the newest by default), the counters (Requests, Not allowed and Failed always, then the counters with a count that month by label), one row per Project with its environments, a Service row and the totals. A Project the backend no longer has reads "Deleted project"; a `service.count` naming only a ProjectEnvironment shows under that ProjectEnvironment's Project. The file is read with the Call log's rules and errors.

### Built-ins

- The built-ins (`public-api`, `incoming-email`, `whatsapp`) run in the backend as services behind the **built-ins adapter**, at `/api/internal/external-services/built-ins/<slug>/…`. The Gate's caller lane and webhook lane forward to it exactly as to a pod (resolve answers `servedBy: "built-in"` with that path), and the backend's own form calls and hooks reach it in process. It verifies a Caller identity signed with a key derived for that built-in from `EXTERNAL_SERVICES_ENCRYPTION_KEY`; a caller-less identity names the tenant `no-tenant`.
- The adapter's records go to the platform's tables in the records file's shapes, and nothing else writes them: each request's row to `external_service_calls` (path without query, `outcome` `handled`, `not supported`, `not allowed` or `failed`, `reason`, caller kind, sizes, duration and notes), and its counts to `external_service_usage` (`requests`, `not_allowed` and `failed` for `call` requests, `events` per stored Event). A row with no ProjectEnvironment (a webhook, a Service-form call) belongs to no Organization and is shown to none; a count with no ProjectEnvironment is dropped. Rows live for `EXTERNAL_SERVICE_CALL_LOG_RETENTION_DAYS` days (default 30): a daily BullMQ job, `external-service-call-log-cleanup`, deletes older rows 1000 at a time and leaves Usage untouched.
- A built-in's `external_service_usage` rows are bound to the authenticated tenant; its Organization reference is durable while the Project and environment references null out on delete, so history survives a deleted Project, shown as "Deleted project".
- The service page's Calls tab of a built-in reads `services/<id>/call-log` like a Custom service's, with no copy switch, for whoever can read its Usage (`can_manage_tenant_external_services`), showing the Organization's rows; the Project dialog reads its own ProjectEnvironment's.

## Edge cases

- When a service cannot write its records file, the request is still answered and the failure is printed once to its process log; rows are committed at most a second after their answer ends, so a pod that dies loses at most that second's rows.
- When a long stream ends, its row appears with the time the request started, so it can land below rows already shown.
- When a built-in's row insert fails, the call's answer still goes out and the failure is logged.
- When a repeated Event is ignored by the store, a built-in's Usage counts nothing for it.

## Code

- `external-service-sdk/src/service-records.ts` — the SDK's writer.
- `backend/src/external-services/calls/` — the read-only reader of a service's `data/service-records.db` and of the built-ins' rows, and the retention job of the built-ins' rows.
- `backend/src/external-services/usage/` — the built-ins' Usage writer and the Usage tab's reader of both sources.
- `backend/src/external-services/built-ins/` — the built-ins adapter, its routes and its records writer.
- `frontend/src/components/external-service/call-log.tsx` — the Calls table, with its row side panel.
- `frontend/src/components/external-service/service-usage.tsx` — the service page's Usage tab.

## Related

- [Gate](gate.md) — how a call reaches the service that records it.
- [Event](events.md) — webhook rows, and the Events a built-in's Usage counts.
- [Permissions](../organization/permissions.md) — the permissions the Calls and Usage tabs need.
