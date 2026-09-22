---
kind: explanation
terms: [Request Logging, Logging level, Body limit]
adrs: [0006]
---

# Request Logging

> How much of an App's live traffic does the app-mode proxy record, and how does a [Project](../../CONTEXT.md) change that?

## How it works

- Every Project's App traffic flows through the shared app-mode runtime proxy, which records each HTTP request to the environment's SQLite log, the `app_requests` table the [DB viewer](../runtime/pod-tools.md) surfaces.
- [Request Logging](../../CONTEXT.md) is the Project's [Logging level](../../CONTEXT.md): Off records nothing and streams without buffering; Metadata records method, path, status, latency, size and redacted headers; Full adds each body up to the [Body limit](../../CONTEXT.md), 256 KB by default and capped at 3 MB.
- At Full the proxy streams the response while tee-ing only the first bytes up to the limit into the log, so memory per request is bounded whatever the body size and streaming is preserved ([ADR-0006](../adr/0006-request-log-streaming-tee.md)); Full is the default.
- `Authorization`, `Cookie` and the internal proxy control token are always redacted; end-user identity headers such as `x-forwarded-email` stay visible as debugging signal.
- The proxy learns the level from the ensure response it already fetches per request, cached a few seconds, so a change applies within seconds with no restart ([Request Flows](../runtime/request-flows.md)).
- Changing the level requires `can_manage_project_logging_settings`; reading it rides the normal project payload ([Permissions](../organization/permissions.md)).

## Edge cases

- When the ensure response carries no policy (an older backend or a non-App surface), the proxy falls back to Full.
- Log retention is a separate cleanup job, independent of the level.

## Code

- `proxy/internal/server/server.go` — policy resolution, the streaming tee and redaction.
- `proxy/internal/requestlog/` — the SQLite writer.
- `backend/src/project/` — the guarded logging-settings endpoint and the policy on the ensure response.
- `project_settings` in `backend/db/schema.ts` — the stored level and limit per Project.

## Related

- [Pod Tools](../runtime/pod-tools.md) — where the log is read.
- [Request Flows](../runtime/request-flows.md) — the ensure call that carries the policy.
