# Changelog

Minor versions only add optional things; a service written for `2.0.0` runs on every `2.x`. A change that breaks the wire or the manifest is a new `sdk` major.

## 2.1.0

- `"connectedByDefault": true` in the manifest connects every new Project to the service while it is Available: the Project starts with a Project configuration made from the Project form's defaults and generated values, as if a person had saved it.

## 2.0.1

- A caller that hangs up during a streamed upload no longer crashes the service: the upload to the upstream is cancelled and every other request keeps being answered.

## 2.0.0

SDK 2 is the only SDK in this package: a service is a transparent proxy with a policy. Its wire is [WIRE-CONTRACT.md](WIRE-CONTRACT.md). A service written for `1.x` does not run on `2.x` and has no upgrade path; its builder rebuilds it on SDK 2.

- The manifest (`"sdk": 2`): identity, `inbound`, both forms and `events` (a title and a description each); `operations`, `bounds` and `$defs` are refused with "SDK 2 has no Operations; enforce this in your Service policy".
- `defineService`, `route`, `upstream`, `allowAll`: ordered Service routes (first match wins, none = not supported) that proxy to an upstream, are handled by the service or refuse; every route names its `allowedBy` settings (`[]` when none).
- Checks fail closed; unsafe paths are refused and every other path is forwarded byte for byte; the caller's credentials are stripped before the upstream's own are added; bodies and answers stream untouched unless a check or `through` reads them.
- A Caller identity is required on every request; refusals carry `Opsiforce-Outcome` / `Opsiforce-Setting`, with one `refusal()` override, the secret-in-answer refusal for `handle` routes and `GET /.well-known/opsiforce`.
- Both configurations are fetched from `$SERVICE_GATEWAY_URL/configuration` (and `service.projectConfigurations()` from `…/configuration/projects`) with the pod's key, kept in memory for at most 5 s; *not connected* and an *incomplete* Project configuration are refused before any route, and the missing Service-form fields are `ctx.missingServiceFields`.
- `options`, `info`, `buttons` and `hooks` answer the platform's form calls and save hooks at `/.well-known/opsiforce/{options|info|buttons|hooks}/<name>`; `webhook` answers the Webhook address at `/.well-known/opsiforce/webhook/**` and `service.deliver()` hands Events to `$SERVICE_GATEWAY_URL/events`.
- `data/service-records.db`: one Call log row per identified request (pruned after 30 days; a webhook row's reason says what it delivered, or the status the handler refused it with) and the Usage counters (`requests`, `not_allowed`, `failed`, `events` and up to 20 declared ones via `ctx.count` / `service.count`).
- Every failure the SDK answers itself reads in plain words with the service's `displayName` ("… couldn't do this. Try again; …", "… couldn't reach its upstream system. …", "…'s answer was blocked because it contained a stored secret.", "This form is out of date. …"); what failed is only in the Call log reason. `check` warns about a value field with no `label`.
- `ctx.state.update` is atomic per key.
- `serve` and `dev` never time a request out, keep idle connections 75 s and take `service.webhookUrl` from `$SERVICE_WEBHOOK_URL`.
- `testService(service, { … })` runs the real in-memory server; `external-service-cli check | types | dev | serve | report`.
- Removed with SDK 1: Operations, `defineHandlers`, `ctx.bounds`, `ctx.file`, `ctx.platformApi`, `ctx.log`, `ServiceError`, `rateLimited`, `upstreamUnauthorized`, `problem`, `@opsiforce/external-service-sdk/openapi`, `generate --from-openapi`, the `/_service/*` wire and `GET /_service/health`, and the `--built-in` flag.

## 1.0.0

- The Service manifest v1 (`"sdk": 1`): field catalog, Service and Project forms, Operations with kinds and input schemas, named bounds, Events.
- `defineHandlers` with Operations, options, info, buttons, save hooks and `inbound`.
- `ctx`: `serviceConfiguration` with `Secret`s, `projectConfiguration`, `bounds`, `state`, `caller`, `callId`, `webhookUrl`, `signal`, `log`, `file()`.
- `ServiceError`, `rateLimited`, `upstreamUnauthorized`.
- The `/_service/*` HTTP server with `GET /_service/health`.
- The test kit `@opsiforce/external-service-sdk/testing`.
- `external-service-cli check | types | generate --from-openapi | dev | serve | report`.
- `openApiRouteRequest` and `@opsiforce/external-service-sdk/openapi` (`writeServiceFromOpenApi`), for a service that wraps an existing OpenAPI.
- `ctx.platformApi` for Built-in External Services only.
- `GET /_service/health` answers the full `sdkVersion` beside the `sdk` major.
- `ctx.caller.via` is any string: `agent`, `app` and `form` today, so a later platform value never fails a 1.x service.
- The test kit hands handlers only the referenced Service configuration list items and withholds an answer that echoes a sent secret (`502 secret-in-response`), as the Gate does.
- The tarball pins `zod` and `ajv` exactly and is reproducible; `/forms` and `/platform` are platform-only and not in its exports.
