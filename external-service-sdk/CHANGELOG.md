# Changelog

Minor versions only add optional things; a service written for `1.0.0` runs on every `1.x`. A change that breaks the `/_service/*` wire or the manifest is a new `sdk` major.

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
