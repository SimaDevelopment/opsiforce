# Wire contract

Everything the Opsiforce platform depends on in an External Service (`"sdk": 2` in `service.json`). The Node SDK in this package is its only implementation; a service that bypasses the SDK must still honour every line here, and the platform checks the first two before every Publish. Changing a line is a new `sdk` major.

## Who is calling: the Caller identity

- Every request reaching the service carries `X-Opsiforce-Caller`: a JWT (`{"alg":"HS256","typ":"JWT"}`), HMAC-SHA256 signed with the receiving pod's own Gateway Key (`SERVICE_GATEWAY_API_KEY`). Development and Default copies hold different keys, so a token checks out only at the copy it was made for.
- Claims: `kind` (`call` | `platform`), `tenantId`, `projectId`, `projectEnvironmentId`, `environment` (the environment slug), `iat`, `exp` (about 2 minutes after `iat`). A `call` always names `projectId`, `projectEnvironmentId` and `environment`; a `platform` token names a ProjectEnvironment only when the platform acts for one.
- The service checks it once, at request start: a missing, malformed, wrongly signed or expired token, or a `call` without a ProjectEnvironment, is answered `401` with `Opsiforce-Outcome: unidentified` before anything else, with no Call log row and no opt-out.
- **Publish probe 1:** a request with no Caller identity must answer exactly `401` + `Opsiforce-Outcome: unidentified`.

## Connections

- The Gate speaks HTTP/1.1 to the pod and reuses idle keep-alive connections for at most 60 s. The service keeps an idle connection open longer than that (the SDK: 75 s) and never times a request out, so a long upload or stream is never cut and the Gate never reuses a connection the pod is closing.
- Through the Service host the path arrives with its `.` and `..` segments already resolved by the edge; the Gate changes nothing else in the request. The service still refuses an unsafe path it receives (the SDK: `.` or `..` segments, `//`, `%2F` or `%5C` → `not supported`), so a request that reaches it unresolved is refused too.

## Refusals and the `Opsiforce-*` headers

| Outcome | Status |
|---|---|
| `not supported` | 404 |
| `not allowed` | 403 |
| `not connected` | 403 |
| `incomplete` | 403 |
| `failed` | 502 (413 for a body over the route's `bodyLimit`) |
| `unidentified` | 401 |

- Every refusal the SDK makes itself, with one of the outcomes above, carries `Opsiforce-Outcome: <outcome>` and, when a Project-form setting governs the refusal, `Opsiforce-Setting: <field key>`. A service's `refusal()` override replaces the body only: it can change neither the status nor these two headers.
- The default body is `application/json` `{ "outcome", "message", "setting", "link" }` (`setting` and `link` are `null` when absent). `message` is the author's text, then the setting's label and the link; it is the same text as the Call log reason. A `failed` refusal's `message` is plain words naming the service's `displayName` instead: `"<displayName> couldn't do this. Try again; if it keeps failing, an Organization admin can check this service's Calls."`, `"<displayName> couldn't reach its upstream system. …"` or `"<displayName>'s answer was blocked because it contained a stored secret."`; only the Call log reason says what failed (`"handle threw: …"`, `"upstream failed: …"`). `link` is the configuration fetch's settings link plus `&field=<key>`.
- Before any route, with a Caller identity naming a ProjectEnvironment: no Project configuration = `not connected`; a required Project-form field missing = `incomplete` naming it. A required Service-form field missing refuses nothing: route code reads the missing keys (`ctx.missingServiceFields`) and refuses itself when it cannot work without one.
- **Publish probe 2:** a valid `call` identity for a ProjectEnvironment with no Project configuration must answer exactly `403` + `Opsiforce-Outcome: not connected`.

## `GET /.well-known/opsiforce`

Answered by the SDK before any route, for `call` and `platform` callers alike; the whole `/.well-known/opsiforce/…` subtree is never matched by a Service route.

```json
{ "sdk": "2.0.0",
  "manifestHash": "<sha-256 of the canonical service.json>",
  "settingsLink": "https://<base>/projects/p-42?configure=boards",
  "configuration": { "boards": { "label": "Boards", "value": [{ "boardId": "B1", "access": "cards" }] } },
  "upstreams": [{ "name": "api", "api": "Boards REST API v1", "url": "https://api.example.com", "mount": "/api/v1" }],
  "routes": [
    { "route": "POST /api/v1/cards/:card/archive", "action": "proxy", "upstream": "api", "summary": "Archive a card", "allowedBy": ["boards"] },
    { "route": "* /api/v1/boards/:board/automations/**", "action": "refuse", "summary": "Board automations are not available through this service", "allowedBy": [] },
    { "route": "GET /api/meta", "action": "handle", "summary": "Client shim: the version document the CLI asks a self-hosted instance for", "allowedBy": [], "allowAll": true } ] }
```

`routes` is the flat, ordered route table (first match wins); every route lists in `allowedBy` the Project-form settings that govern it, `[]` when none does. `settingsLink` appears when the token names a ProjectEnvironment, and `configuration` only when that ProjectEnvironment is connected; `configuration` is keyed by Project-form field, secrets shown as `"[secret]"`. A function `url` shows its value for the caller. `allowAll` appears only when true. Readers ignore unknown keys.

## Form calls and save hooks: `/.well-known/opsiforce/{options|info|buttons|hooks}/<name>`

- Backend → pod directly, `POST`, `application/json`, with a `platform` Caller identity: it names the ProjectEnvironment for a Project-form call and `onProjectConfigurationSaved`, and none for a Service-form call and `onServiceConfigurationSaved`. A `call` identity there is answered `404` + `not supported`, and so is a Project-form call or `onProjectConfigurationSaved` whose identity names no ProjectEnvironment. These paths run the named handlers, never a Service route.
- `options|info|buttons/<name>` body: `{ "form": "serviceForm" | "projectForm", "values": {…}, "query"?: "…", "item"?: "<list item id>" }`; `values` is the whole unsaved draft, stored secrets merged in and opened. Answer `200` JSON: options `[{ value, label, description? }]`, info `{ text, level? }`, a button `{ message, level? }`, `{ image: { mimeType, base64 }, caption? }` or `{ link, label? }`. The platform keeps the first 50 options, an image only as png, jpeg, gif or webp of at most 1 MB, and reads at most 2 MB of any answer.
- `hooks/<onServiceConfigurationSaved|onProjectConfigurationSaved>` body: `{ "previous": {…} | null, "current": {…} | null }`, secrets opened. The service drops its kept configuration first, then runs its hook, and answers `204`, also when it declares no such hook.
- An unknown handler name is `404` + `not supported`; a handler that throws, or an answer containing a secret value of the Service configuration, is `502` + `failed`. A form call the service cannot take (unknown name, unreadable body, no `form`, no ProjectEnvironment where one is needed) answers `"This form is out of date. Reload the page and try again."`, with what was wrong in the Call log reason. Every answer on these paths carries the manifest hash in `x-opsiforce-manifest`, and a request naming another hash in `x-opsiforce-expected-manifest` is answered `503 { code: "service-reloading" }` before any handler runs.

## The Webhook address: `/.well-known/opsiforce/webhook/<rest of path>`

- The Webhook address `https://<main host>/api/external-services/webhooks/<service id>` (Development: `…/<service id>/development`), given to each copy's pod in `SERVICE_WEBHOOK_URL` (`service.webhookUrl`), reaches the copy's pod at `/.well-known/opsiforce/webhook` plus whatever path followed the address, any method, query, headers and body untouched. No key is needed and `Authorization` passes through; the platform drops `Cookie` and every incoming `X-Opsiforce-*` but `X-Opsiforce-Webhook-Secret`, adds a `platform` Caller identity naming no ProjectEnvironment, and adds `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` to the answer.
- The service runs its one `webhook` handler there, never a Service route. A `call` identity, or a service whose `service.json` has no `inbound: true` or that has no handler, is answered `404` + `not supported`.
- The handler's own answer goes back to the provider (refused as `failed` if it contains a secret value of the Service configuration). A handler that answers nothing gets `200 {"received": true}` when every delivery it made was `stored` or `duplicate`, else `503` with `Retry-After: 60`, so the provider retries and the Event `key` dedupes. The request's Call log row is `failed` when any delivery made during it was `over-cap` or `not-connected` (reason `"pe-3 over the Event cap"`, `"pe-4 is not connected"`); otherwise it is `handled`, with what it delivered as its reason (`"issue.opened → 2 environments, 1 already had it"`), or `"the webhook answered 401"` when the handler answered the provider with a 4xx or 5xx. The SDK retries nothing.

## Configuration fetch

- `GET $SERVICE_GATEWAY_URL/configuration` with `Authorization: Bearer <the pod's Gateway Key>`, plus the request's `X-Opsiforce-Caller` when asked inside a request. The asking pod's key picks the Service configuration: Development's own for the Development pod, the callers' one for the Default copy.
- Answer `200`: `{ "serviceConfiguration": {…}, "projectConfiguration": {…} | null, "missing": { "serviceForm": ["<key>"…], "projectForm": ["<key>"…] }, "settingsLink": "https://<base>/projects/<projectId>?configure=<slug>" }`, secrets opened. `projectConfiguration` is `null` (not connected) when the Caller identity names a ProjectEnvironment with no Project configuration, or names none; `settingsLink` is present only when it names one. `missing` lists the required fields each configuration lacks, read tolerantly against the current manifest.
- `GET $SERVICE_GATEWAY_URL/configuration/projects` with the same key: `200 { "projectConfigurations": [{ "projectId", "projectEnvironmentId", "projectConfiguration" }] }`, every connected ProjectEnvironment of the copy's lane (the Test Project's for Development, every other one for the Default copy).
- `401 { "message" }` for an unknown key or a Caller identity that does not verify with it; `403 { "message" }` for a key that belongs to no copy of a service, or an identity naming a ProjectEnvironment of another Organization.
- The SDK caches each answer in process memory only, at most 5 s, per ProjectEnvironment ("none" is cached the same way), and never caches a failed fetch. A request reads its configuration once, when it starts. Every save hook drops the cached copy first: `onProjectConfigurationSaved` that ProjectEnvironment's, the caller-less one and the list; `onServiceConfigurationSaved` all of them.

## `POST $SERVICE_GATEWAY_URL/events`

- `service.deliver({ type, key, occurredAt, data, files? }, { to: [projectEnvironmentId…] })`, from any code (webhook handler, route, poll loop). Always `multipart/form-data` with `Authorization: Bearer <the pod's Gateway Key>`, plus `X-Opsiforce-Caller` when sent during a request: a text part `event` = `{ "type", "key", "occurredAt", "data", "to": [...], "files": [{ "part": "file-0", "name", "mimeType" }] }` and one file part per entry of `files`, named by its `part`.
- The platform checks the envelope only: `type` declared in `service.json` `events` (≤ 100 characters), `key` 1–500 characters, `occurredAt` a parseable date (≤ 64 characters), `data` a JSON object, `to` 1–100 ProjectEnvironment ids, every `files[].part` present (name ≤ 255 characters). It never validates `data`. Size caps: 25 MB per file, 20 files, 30 MB in all.
- Each receiver is checked for who it is only: connected (it has a Project configuration of this service) and in the copy's lane (the Development copy delivers only to its Test Project, the Default copy never does). At most 60 deliveries per receiving ProjectEnvironment per service per minute.
- Answers: `200 { "results": [{ "projectEnvironmentId", "result": "stored" | "duplicate" | "not-connected" | "over-cap" }] }`, one per distinct receiver in `to` order, after every `stored` Event is in its receiver's `external-services.db` and its App's doorbell is queued; `duplicate` = the receiver already holds this service × `type` × `key`. `400 { "problems": ["…"] }` before anything is stored; `413 { "message" }` over a size cap; `401 { "message" }` for an unknown key or a Caller identity that does not verify with it, `403 { "message" }` for a key of no service copy; `5xx { "message" }` when storing or queueing the doorbell failed (send it again; `key` dedupes).
- `deliver()` resolves to the `results` and throws on any other answer. Each `stored` result adds 1 to the built-in `events` Usage counter of that ProjectEnvironment.

## Records file

One SQLite file `data/service-records.db` in the copy's workspace, beside `data/service-state.db`. One writer: the SDK in the pod, on one connection, with `journal_mode = TRUNCATE` (a rollback journal), `synchronous = FULL`, `locking_mode = NORMAL`; never WAL, never exclusive locking. The SDK batches rows and counts into one transaction at most once a second, at once when 10 000 rows or counts are waiting, and on shutdown; only a failed write loses its batch. `PRAGMA user_version` is the schema version, `2` (`1` had no `usage` table).

The platform opens the file read-only (`SQLITE_OPEN_READONLY`) on a fresh connection per read and never writes to it. A read that meets a hot journal (`SQLITE_READONLY_ROLLBACK`) or a torn page (`SQLITE_CORRUPT`) is retried briefly, then reported as "records busy, reload". A missing file or table reads as no rows.

### `calls`: the Call log

One row per request that carries a valid Caller identity, Service routes and `/.well-known/opsiforce/…` alike, written when the answer ends; a request without one leaves no row. Rows older than 30 days (by `time`) are deleted by the SDK.

```sql
CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,     -- a UUID per request
  time TEXT NOT NULL,                  -- request start, ISO-8601 UTC with milliseconds: 2026-10-17T09:30:00.123Z
  caller_kind TEXT NOT NULL,           -- call | platform
  project_id TEXT,                     -- from the Caller identity; NULL when it names none
  project_environment_id TEXT,
  environment TEXT,                    -- the environment slug
  method TEXT NOT NULL,
  path TEXT NOT NULL,                  -- without the query
  route TEXT,                          -- the matched route's summary, the handler (options.<name>, hooks.<name>, …), webhook, the /.well-known/opsiforce path, or NULL
  outcome TEXT NOT NULL,               -- proxied | handled | not supported | not allowed | failed
  reason TEXT,                         -- the refusal or failure text; on a handled webhook row what it delivered or the status it refused with; else NULL
  status INTEGER NOT NULL,             -- the status the caller got (101 for an upgraded connection)
  bytes_in INTEGER NOT NULL,           -- request body bytes: Content-Length when declared, else the bytes read
  bytes_out INTEGER NOT NULL,          -- answer body bytes sent
  duration_ms INTEGER NOT NULL,        -- until the answer ended
  notes TEXT NOT NULL                  -- JSON object of the ctx.note fields, '{}' when none
) STRICT;
CREATE INDEX calls_by_time ON calls (time, id);
CREATE INDEX calls_by_project ON calls (project_id, time, id);
CREATE INDEX calls_by_project_environment ON calls (project_environment_id, time, id);
```

- `outcome`: `proxied` = forwarded to an upstream, its status kept (a `through` route too); `handled` = answered by service code or the SDK itself; `not supported` = no route, a refuse route, an unsafe path or a `notSupported` verdict; `not allowed` = a `notAllowed` verdict, and the SDK's own *not connected* and *incomplete* refusals; `failed` = a check or handler threw or gave no verdict, the configuration fetch or the upstream failed, a body over `bodyLimit`.
- No headers, bodies, query strings or person are ever stored.
- Readers page newest first by `(time, id)`.

### `usage`: the Usage

One row per UTC month × Project × ProjectEnvironment × counter, holding the month's total. Counts only go up and no row is ever deleted. A removed counter keeps its past months under the label stored with the row; each write refreshes `label` and `description` to the code's current ones.

```sql
CREATE TABLE usage (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,                 -- UTC calendar month: 2026-10
  project_id TEXT,                     -- NULL for a Service row, or for service.count naming only a ProjectEnvironment
  project_environment_id TEXT,         -- NULL for a Service row
  name TEXT NOT NULL,                  -- ^[a-z][a-z0-9_]{0,62}$
  label TEXT NOT NULL,                 -- ≤ 60 characters
  description TEXT,
  value INTEGER NOT NULL               -- the month's total
) STRICT;
CREATE UNIQUE INDEX usage_by_count ON usage (month, ifnull(project_id, ''), ifnull(project_environment_id, ''), name);
```

- Built-in counters, written by the SDK and never skippable: `requests` (every `call` request with a row), `not_allowed` (its outcome is `not allowed`), `failed` (its outcome is `failed`), counted in the month of the row's `time`; `platform` requests are never counted. `events` (one per `stored` delivery result, on the receiving ProjectEnvironment, `project_id` NULL) is written by `service.deliver`.
- Declared counters: `defineService({ counters: { <name>: { label, description? } } })`, at most 20, never a built-in name. `ctx.count(name, n = 1)` writes the request's Project and ProjectEnvironment; `service.count(name, n, { projectEnvironment? })` writes `project_id` NULL and the given ProjectEnvironment, or a Service row without one. `n` is an integer from 1 to 10⁹; anything else, or an undeclared name, throws. Counted in the month the call happens.
- A row with `project_id` NULL and a `project_environment_id` belongs to that ProjectEnvironment's Project; readers look the Project up.
