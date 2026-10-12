---
kind: explanation
terms: [Event]
adrs: [0047, 0084]
---

# Event

> What happens between an outside system's webhook and the App that receives it: verification, routing, the per-environment store and the doorbell?

## How it works

### The front door

- An outside system posts to `/api/external-services/webhooks/<slug>` for a [Built-in External Service](../../GLOSSARY.md) and to `…/webhooks/<external_service_id>` for a published [Custom External Service](../../GLOSSARY.md), a URL that stays the service's across [Default environment (External Service)](../../GLOSSARY.md) switches; `…/webhooks/<external_service_id>/development` is the builder's test lane, matched only to its chat's Test Project ([External Service Builder](external-service-builder.md)). A handler reads its own URL as `ctx.webhookUrl`.
- `OPSIFORCE_PUBLIC_URL` is the base of every webhook URL and is never taken from a request's `Host` header ([ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)). Every deployment sets it: the chart refuses to render without it and the backend refuses to boot unless it is an absolute `http(s)` URL.
- Both URLs answer `HEAD` with an empty `200` without reaching any service (`404` when the name is no service), because some providers (Trello) check a callback URL that way before they create a webhook; the edge lets `POST` and `HEAD` there through without sign-in.
- The front door caps a JSON or form body at 5 MB and a multipart one at 25 MB per file, 20 files and 30 MB in all, answering `413` past them. A name no service has answers `404 unknown-service`, a manifest without `"inbound": true` `404 no-inbound`, a service that is not [Available](../../GLOSSARY.md) `503 service-not-configured` and a disabled custom service `503 service-disabled`.
- The service's `inbound` handler gets the method, headers, query, the exact raw body (empty for multipart, whose fields and files arrive parsed) and the whole Service configuration with secrets opened, never a Project configuration. It rejects with a `401` problem, which the provider receives as is, or returns `{events: [{type, key, occurredAt, data, files?}], response?}`; the answer passes the [Gate](gate.md)'s answer checks. A custom service's `inbound` runs in its Default environment's pod.

### Routing

- Each [Event](../../GLOSSARY.md)'s `data` is checked against its type's schema; a misfit or an undeclared type is dropped and logged `invalid_event` ([ADR-0084](../adr/0084-the-platform-routes-incoming-events-by-the-same-bounds-as-operations-and-wakes-the-app-to-receive-them.md)).
- Receivers are the ProjectEnvironments whose Project configuration has `receive[<type>]` on and holds every bound value the Event carries: one JSONB containment query per Event over `external_service_project_configs.values` (an `unless` value is an alternative), confirmed by the Gate's own bound check on the tolerant read. A built-in Event with no bound value reaches nobody; an unbound custom Event reaches every environment of its Organization that receives the type.
- An Event nobody receives is answered `200` and logged `unmatched`. Verification runs first, so unsigned traffic never reaches a tenant's database or a counter, and routing is status-blind: a stopped, suspended or disabled environment still gets its Events stored.
- The provider gets the handler's `response` or `200 {"received": true}`. A `response` keeps only a JSON, XML or plain-text content type (anything else becomes `text/plain`), `retry-after` and `x-…` headers except those a proxy or browser acts on (`x-accel-…`, `x-sendfile…`, `x-forwarded-…`, `x-original-…`, `x-real-ip`, `x-frame-options`, `x-opsiforce-…` and the like), and no `3xx` status (it becomes `200`), and every answer carries `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so a service can never serve a page or a redirect on the platform's origin. The request writes one Call of kind `inbound` (no Organization for a built-in; the Event types in `operation`, the bound values in `bounds`, `invalid_event` or `unmatched` in `code`, or `service-moved` on the first of two Calls when a Default switch made the Gate route the webhook again).

```
provider ──POST webhooks/<service>──▶ inbound handler: verify, parse into Events
                                       │ rejects ⇒ its 401, nothing stored
                                       ▼
                                    schema check per Event (misfit ⇒ invalid_event)
                                       ▼
                                    receive switch + bounds ⇒ ProjectEnvironment(s)
                                       │ nobody ⇒ 200, logged unmatched
                                       ▼
                                    store in each environment's external-services.db
                                       ▼
                                    Usage +1 per new Event · queue one doorbell per environment and service
                                       ▼
                                    200 (or the handler's response) ──▶ provider is done
                                       ┆ later, retried with backoff
                                       ▼
                                    doorbell: wake the App, POST eventIds, stamp app_delivered_at
```

### The store

- Each ProjectEnvironment has `data/external-services.db` beside its workspace, shared by every service; the backend is its only writer, the schema is the platform's ordered migration list applied on first write with the version in `PRAGMA user_version`, and the file appears with the first Event ([ADR-0047](../adr/0047-external-services-store-is-a-platform-owned-sqlite-file-per-environment-with-a-notification-callback.md)). Datasette serves it read-only ([Pod Tools](../runtime/pod-tools.md)).
- Events go into `events` (`id`, `service`, `type`, `key`, `occurred_at`, `received_at`, `data` JSON, `app_delivered_at`, unique on `service, type, key`) and `event_files` (`event_id`, `name`, `mime_type`, `size_bytes`, `path`), each file's bytes at `/workspace/data/external-services/files/<event id>/<name>`; no raw payload and no BLOBs, kept for good. A redelivered Event is stored once and counted once.
- A legacy environment is one whose file held `messages` rows when it met the store's third migration, or one wired in v1 for incoming email or WhatsApp (a row in the v1 `external_service_config` the upgrade leaves in place), marked when its first Event is stored even into a new file; either is recorded once in `store_marks`. For incoming email and WhatsApp, each Event newly stored there is also written as a `messages` row with inline `attachments` in the same transaction, and its ring carries those `rowIds` too; no other environment gets `messages` rows.

### The doorbell

- Before the provider gets its answer and before the Call is written, the inbound pipeline queues one BullMQ job per environment and service on `external-service-doorbell`; a job already waiting for that pair absorbs the new Events, and one already ringing gets a single follow-up ring queued behind it. At ring time it wakes the App as Schedules do (up to 120 s, counted as app activity), reads up to 500 undelivered Event ids and posts `{service, eventIds}` (plus `rowIds` in a legacy environment) to the App's `/api/external-services/<service>` with no auth header and a 10 s timeout.
- A 2xx stamps `app_delivered_at` and rings again at once if more are waiting; a 5xx, a timeout or an App that did not start rings again after 30 s, 2 min, 10 min, 1 h and 6 h, then waits for the next Event or App start; any other 4xx stops ringing until the next Event or App start (`app-refused`). Each ring writes a Call of kind `delivery`.
- The App templates ship one catch-all `POST /api/external-services/<service>` answering `501`. A `404` or `501` marks the pair not wired, on its Project configuration: nothing wakes the App for it again until the App reports it is serving, which clears the mark. The `platform` skill's Inbound Events section teaches Agents and Apps to read `events` and answer the doorbell ([Platform Skill](../agent-system/platform-skill.md)).
- Each time the App reports it is serving, the doorbell rings at once for every service configured on that environment: a ring waiting out a retry is brought forward and its backoff starts again at 30 s, and a ring that finds nothing undelivered ends without waking the App or writing a Call. A new Event never brings a waiting retry forward, so a long outage keeps its backoff.

## Edge cases

- When verification fails, the provider gets the handler's `401` and nothing is stored.
- When the store fails for any receiver, the front door answers `500 event-store-failed` so the provider sends again, and the repeat is stored once.
- When the doorbell cannot be queued, the front door answers `503 doorbell-unavailable` and the Call and Usage record that 503; the Events are already stored, so the resend only rings.
- When the backend restarts between queueing and ringing, the job survives in Redis and rings afterwards.
- When the App's pod is asleep, the doorbell wakes it; an App can always catch up by selecting rows with `app_delivered_at IS NULL`.
- When the Usage increment fails, the platform logs it and still answers, so the counter can only undercount.

## Code

- `backend/src/external-services/http/` — the webhook routes, body caps and the request the handler sees.
- `backend/src/external-services/inbound/` — the pipeline from handler answer to stored Events, receiver matching and the ring.
- `backend/src/external-services/inbound/external-service-store.ts` — the per-environment SQLite store and its migrations.
- `backend/src/external-services/doorbell/` — the durable doorbell: the queue, the ring and the not-wired marks.
- `backend/src/external-services/legacy/` — the `messages` rows legacy environments get next to their Events.
- `agent-config/agents/app-builder/template/app/backend/src/external-services/` — the App-side catch-all.

## Related

- [Service manifest](service-manifest.md) — declaring Event types, their data and their bounds.
- [Configuration](configuration.md) — the Receive switches and the bounds a Project configuration holds.
- [Incoming Email](incoming-email.md) — the email built-in's Events.
- [WhatsApp](whatsapp.md) — the WhatsApp built-in's Events.
- [Pod Tools](../runtime/pod-tools.md) — Datasette serving the store read-only.
- [Publish](../projects/publish.md) — how Receive hands over from Development.
