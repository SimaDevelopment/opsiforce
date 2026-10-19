---
kind: explanation
terms: [Event]
adrs: [0047, 0084]
---

# Event

> What happens between an outside system's webhook and the App that receives it: verification, delivery, the per-environment store and the doorbell?

## How it works

### The Gate

- An outside system posts to `/api/external-services/webhooks/<slug>` for a [Built-in External Service](../../GLOSSARY.md) and to `…/webhooks/<external_service_id>` for a published [Custom External Service](../../GLOSSARY.md), a URL that stays the service's across [Default environment (External Service)](../../GLOSSARY.md) switches; `…/webhooks/<external_service_id>/development` is the builder's test lane, matched only to its chat's Test Project ([External Service Builder](external-service-builder.md)). Each copy's pod gets its address in `SERVICE_WEBHOOK_URL` (Development's for the builder chat's default environment, the service's for every other), which the SDK serves as `service.webhookUrl`.
- `OPSIFORCE_PUBLIC_URL` is the base of every webhook URL and is never taken from a request's `Host` header ([ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)). Every deployment sets it: the chart refuses to render without it and the backend refuses to boot unless it is an absolute `http(s)` URL.
- A Traefik path rule on the main host sends every request under `/api/external-services/webhooks/`, any method and without sign-in, to the webhook port (3008) of the `external-service` runtime proxy, never through oauth2-proxy or nginx ([ADR-0084](../adr/0084-an-external-service-delivers-its-events-to-the-projectenvironments-it-chooses-and-the-platform-keeps-them-and-wakes-the-app.md)). The proxy asks the backend's `POST /api/internal/proxy/external-services/resolve-webhook` which copy serves the address (cached ≤ 5 s, waking a sleeping pod within the 60 s hold), drops `Cookie` and every incoming `X-Opsiforce-*` but `X-Opsiforce-Webhook-Secret` (the header WhatsApp's numbers were registered with), keeps `Authorization` and everything else, and adds `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` to every answer, its own `{"message"}` refusals included.
- A Custom service's address reaches its copy's pod at `/.well-known/opsiforce/webhook` plus the rest of the path and the query, with a `platform` Caller identity naming no ProjectEnvironment. A service without `"inbound": true` answers `404` at the resolve, a disabled one `404` "turned off", a pod that failed `502`, one not up within the hold `504`.
- A built-in's address (`incoming-email`, `whatsapp`) reaches the backend's built-ins adapter the same way, at `/api/internal/external-services/built-ins/<slug>/.well-known/opsiforce/webhook` plus the rest, with a `platform` Caller identity the backend signs for that built-in ([Call log](call-log.md#built-ins)). Its handler delivers in process through the same envelope, receiver and cap checks and the same `deliver()` results as `POST /events` below (nothing is uploaded, so the multipart size caps do not apply), and its v1 double writes run inside it.
- Any method reaches the webhook handler, `HEAD` included, so a service answers a provider that checks its callback URL first itself.

### Delivery

- The service's `webhook` handler verifies the request itself, reads the Project configurations it needs (`service.projectConfigurations()`), and calls `service.deliver({type, key, occurredAt, data, files}, {to: [projectEnvironmentId…]})`, from the handler or any other code (a poll loop, a schedule). That is one multipart `POST $SERVICE_GATEWAY_URL/events` (`/api/gateway/events`) with the pod's Gateway Key; the shape is fixed in the SDK's `WIRE-CONTRACT.md`.
- The backend checks the envelope only (declared type, `key`, a parseable `occurredAt`, a JSON-object `data`, 1–100 receivers, every named file part present; a multipart body of at most 20 files of 25 MB and 30 MB in all, else `413`) and answers `400 {problems}` before storing anything; `data` is never validated. Then, per distinct receiver: `not-connected` when it has no Project configuration of this service or is outside the copy's lane (Development delivers only to its Test Project, the Default copy never does), `over-cap` past 60 deliveries per receiving ProjectEnvironment per service in a sliding minute (counted in the backend process), else `stored` or `duplicate` (the same service × type × `key` is already there). It answers `200 {results}` only after every stored Event is in its store and its doorbell is queued.
- The SDK counts `events` Usage per `stored` result in the service's own records file, a built-in in `external_service_usage` ([Call log](call-log.md)). A webhook handler that answers nothing gets `200 {"received": true}` back to the provider when every result was `stored` or `duplicate`, else `503` with `Retry-After: 60` and a `failed` Call log row naming the receivers, so the provider retries and `key` dedupes.

```
provider ──any method webhooks/<service>──▶ Gate: resolve the copy, drop Cookie and X-Opsiforce-*
                                             ▼
                                          the service's webhook handler: verify, pick receivers
                                             │ rejects ⇒ its own answer, nothing stored
                                             ▼
                                          deliver() ──POST /events──▶ envelope check, connected? under the cap?
                                             ▼
                                          store in each environment's external-services.db
                                             ▼
                                          queue one doorbell per environment and service
                                             ▼
                                          200 {results} ──▶ handler answers the provider
                                             ┆ later, retried with backoff
                                             ▼
                                          doorbell: wake the App, POST eventIds, stamp app_delivered_at
```

### The store

- Each ProjectEnvironment has `data/external-services.db` beside its workspace, shared by every service; the backend is its only writer, the schema is the platform's ordered migration list applied on first write with the version in `PRAGMA user_version`, and the file appears with the first Event ([ADR-0047](../adr/0047-external-services-store-is-a-platform-owned-sqlite-file-per-environment-with-a-notification-callback.md)). Datasette serves it read-only ([Pod Tools](../runtime/pod-tools.md)).
- Events go into `events` (`id`, `service`, `type`, `key`, `occurred_at`, `received_at`, `data` JSON, `app_delivered_at`, unique on `service, type, key`) and `event_files` (`event_id`, `name`, `mime_type`, `size_bytes`, `path`), each file's bytes at `/workspace/data/external-services/files/<event id>/<name>`; no raw payload and no BLOBs, kept for good. A redelivered Event is stored once and counted once.
- A legacy environment is one whose file held `messages` rows when it met the store's third migration, or one wired in v1 for incoming email or WhatsApp (a row in the v1 `external_service_config` the upgrade leaves in place), marked when its first Event is stored even into a new file; either is recorded once in `store_marks`. For incoming email and WhatsApp, each Event newly stored there is also written as a `messages` row with inline `attachments` in the same transaction, and its ring carries those `rowIds` too; no other environment gets `messages` rows.

### The doorbell

- Before `POST /events` answers, it queues one BullMQ job per environment and service on `external-service-doorbell`; a job already waiting for that pair absorbs the new Events, and one already ringing gets a single follow-up ring queued behind it. At ring time it wakes the App as Schedules do (up to 120 s, counted as app activity), reads up to 500 undelivered Event ids and posts `{service, eventIds}` (plus `rowIds` in a legacy environment) to the App's `/api/external-services/<service>` with no auth header and a 10 s timeout.
- A 2xx stamps `app_delivered_at` and rings again at once if more are waiting; a 5xx, a timeout or an App that did not start rings again after 30 s, 2 min, 10 min, 1 h and 6 h, then waits for the next Event or App start; any other 4xx stops ringing until the next Event or App start (`app-refused`). A ring the App did not take is logged.
- The App templates ship one catch-all `POST /api/external-services/<service>` answering `501`. A `404` or `501` marks the pair not wired, on its Project configuration: nothing wakes the App for it again until the App reports it is serving, which clears the mark. The pod reports it only when the App comes up (pod start, or the App answering again after being down), so a route added while the App keeps serving waits for the next start; the Project dialog says a restart of the environment rings at once. The `platform` skill's Inbound Events section teaches Agents and Apps to read `events` and answer the doorbell ([Platform Skill](../agent-system/platform-skill.md)).
- Each time the App reports it is serving, the doorbell rings at once for every service configured on that environment: a ring waiting out a retry is brought forward and its backoff starts again at 30 s, and a ring that finds nothing undelivered ends without waking the App. A new Event never brings a waiting retry forward, so a long outage keeps its backoff.

## Edge cases

- When verification fails, the provider gets the handler's refusal and nothing is stored.
- When the backend restarts between queueing and ringing, the job survives in Redis and rings afterwards.
- When the App's pod is asleep, the doorbell wakes it; an App can always catch up by selecting rows with `app_delivered_at IS NULL`.
- When a delivery's store fails for a receiver, `POST /events` answers `500 {message}` after ringing for the stored ones; when the doorbell cannot be queued it answers `503 {message}`. `deliver()` throws on either, so a webhook handler that lets it throw answers the provider `502` and the provider retries; the repeat is stored once and still rings.
- The Project dialog shows, for an enabled service with `"inbound": true`, how many of that environment's Events of the service the App has not taken (`app_delivered_at IS NULL`) and "App not wired" while the doorbell's not-wired mark is set (`GET …/services/<id>/event-delivery`).

## Code

- `proxy/internal/gate/webhook_lane.go` — the webhook lane: address parsing, resolve cache, header drops and the sandboxed answer.
- `resolveWebhook` in `backend/src/external-services/gate/caller-resolution.ts` — which copy serves a Webhook address.
- `backend/src/external-services/http/event-deliveries.controller.ts` — the `POST /events` route and its multipart caps.
- `backend/src/external-services/inbound/` — `POST /events`: envelope checks, receivers, the cap, storing and ringing, and the per-environment SQLite store with its migrations.
- `backend/src/external-services/doorbell/` — the durable doorbell: the queue, the ring and the not-wired marks.
- `agent-config/agents/app-builder/template/app/backend/src/external-services/` — the App-side catch-all.

## Related

- [Service manifest](service-manifest.md) — declaring Event types and `"inbound": true`.
- [Configuration](configuration.md) — the Project configurations a service reads to pick receivers.
- [Incoming Email](incoming-email.md) — the email built-in's Events.
- [WhatsApp](whatsapp.md) — the WhatsApp built-in's Events.
- [Pod Tools](../runtime/pod-tools.md) — Datasette serving the store read-only.
- [Publish](../projects/publish.md) — how a Project configuration is carried from Development.
