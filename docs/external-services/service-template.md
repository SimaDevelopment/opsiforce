---
kind: explanation
adrs: [0046, 0047]
---

# Service template

> How does an inbound external service plug into the platform, and what happens between a provider's webhook and the App's callback?

## How it works

### The template

- Everything inbound lives in one backend module; a service is one definition object registered by name that declares how to verify a request, pull routing keys from a payload, turn a payload into rows, what to do when a message routes nowhere, how to project an environment's inbound identity, any extra routes, and optionally how to provision a new environment and what a [Publish](../projects/publish.md) carries forward.
- The module supplies the rest: the HTTP front door, storage, metering, the doorbell and the publish hook, so registering a service is one definition file and one line in the definitions barrel ([Add an external service](../operations/add-an-external-service.md)).

### Routes and discovery

- Every endpoint lives under `/api/external-services/` and the first segment names the audience: `webhooks/:service` (authenticated by the definition's verify step), `agent/:service/…` (the [Service Gateway](../gateways/service-gateway.md) token, from which the platform resolves the environment) and `admin/:service/…` (an operator session plus `can_manage_external_services`) ([ADR-0046](../adr/0046-external-services-routes-are-audience-first.md)).
- Two dispatch controllers declare their guard once and hand the remaining path to the definition's route table; an admin route that names an environment is tenant-checked by the dispatcher, one that names none reaches the platform-wide resource registry shared by every [Organization](../../CONTEXT.md).
- The names `usage`, `webhooks`, `agent`, `admin` and `services` are reserved; the registry refuses at startup to register a definition that takes one.
- Every definition implements an identity projection mounted at `GET agent/<service>/identity`, always answering 200 with the service's own empty shape and never a secret; mutations such as rotating an address are service-declared routes.
- Signature verification needs no raw body: requests arrive as parsed form fields or JSON, normalised into one shape (`headers`, `fields`, `files`, `json`) before a definition sees them.

### Ingest

- The webhook path is synchronous and short: verify, route, store, meter, 200; the App callback is dispatched after the acknowledgement, once, unretried ([ADR-0047](../adr/0047-external-services-store-is-a-platform-owned-sqlite-file-per-environment-with-a-notification-callback.md)).
- Verification runs first, so unsigned traffic never touches a tenant database or a counter; there is no rate limiting and no platform-side size cap beyond the providers' own.
- Routing outcomes are never a 5xx, and ingest is status-blind: a stopped, suspended or disabled environment still gets its messages stored.

```
provider ──POST /api/external-services/webhooks/<service>──▶ verify (signature / shared secret)
                                             │ fails ⇒ 406, nothing stored
                                             ▼
                                          routing keys ⇒ ProjectEnvironment(s)
                                             │ nothing matches ⇒ 406 or 200-and-drop (per service)
                                             ▼
                                          store rows in the env's external-services.db (one transaction)
                                             ▼
                                          meter: +1 per stored message
                                             ▼
                                          200 ──▶ provider is done
                                             ┆ after the ACK, once, unretried
                                             ▼
                                          doorbell: POST the app, stamp app_delivered_at
```

### Storage and the doorbell

- Each [ProjectEnvironment](../../CONTEXT.md) has `data/external-services.db` beside its workspace with one `messages` and one `attachments` table shared by every service; the backend is the sole writer, the schema is the platform's ordered migration list applied on first write with the version in `PRAGMA user_version`, and a new environment has an empty file until its first message. Datasette serves it read-only ([Pod Tools](../runtime/pod-tools.md)).
- A row carries bookkeeping columns, a promoted set that means the same for every service (who it was routed to, who sent it, the text) and a `payload` JSON column; attachments and media are child rows with bytes inline.
- Idempotency is a unique index on service plus provider message id with inserts ignoring conflicts.
- The doorbell is `POST /api/external-services/<service>` on the App with `{ service, rowIds }` and no content, sent straight to the pod inside the cluster with a modest timeout; the agent template ships one catch-all route answering 501, a 2xx stamps `app_delivered_at`, and anything else leaves it null as the "never delivered" marker.

### Metering and lifecycle

- Every stored message counts one in a monthly bucket per Organization, [Project](../../CONTEXT.md), environment and service; the Organization reference is durable while Project and environment references null out on delete. Admins read it under Admin, Usage, gated by `can_view_external_services_usage` and bound to the authenticated tenant ([Permissions](../organization/permissions.md)).
- Every seam that creates an environment calls one provisioning hook after the row is committed, and a hook failure never fails the flow; a Publish carries each service's wiring only after the new App version has proven ready; deleting an environment cascades its configuration documents while platform-wide resources and metering buckets survive; Duplication and Import copy nothing inbound.

## Edge cases

- When verification fails, the handler answers 406 and stores nothing.
- When a message routes nowhere, email answers 406 and WhatsApp accepts and drops, each per its provider's retry semantics.
- When the App's pod is cold or absent, the doorbell attempt is skipped; the rows are stored and the App catches up by selecting undelivered rows.
- When a stored batch is redelivered, the handler answers 200, writes nothing, meters nothing and rings no doorbell.
- When the metering increment fails, the platform logs loudly and still acknowledges, so the counter can only undercount.
- When a media fetch fails, the attachment row is written with null bytes.
- When the publish carry fails after readiness, the Publish fails before finalizing.
- When a definition takes a reserved name, the backend refuses to boot.

## Code

- `backend/src/external-services/` — the front door, dispatch controllers, registry, ingest, store, doorbell, metering, publish hook and the definitions.
- `backend/src/common/environment-database.ts` — the shared per-environment SQLite writer.
- `externalServiceConfig` in `backend/db/schema.ts` — per-environment configuration documents.
- `externalServiceUsage` in `backend/db/schema.ts` — the monthly metering buckets.
- `agent-config/agents/app-builder/template/app/backend/src/external-services/` — the App-side catch-all stub.
- `agent-config/skills/sqlite/SKILL.md` — how the Agent reads the store.

## Related

- [Incoming Email](incoming-email.md) — the self-served address service.
- [WhatsApp](whatsapp.md) — the operator-assigned channel service.
- [Service Gateway](../gateways/service-gateway.md) — the token the agent mount reuses.
- [Pod Tools](../runtime/pod-tools.md) — Datasette serving the store read-only.
- [Publish](../projects/publish.md) — the carry after readiness.
- [Add an external service](../operations/add-an-external-service.md) — the steps.
