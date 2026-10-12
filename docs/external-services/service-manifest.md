---
kind: explanation
terms: [External Service, Built-in External Service, Service manifest, Operation]
adrs: [0046]
---

# Service manifest

> What is an External Service made of, what does its `service.json` declare, and what does the SDK give the handlers behind it?

## How it works

### The folder

- An [External Service](../../GLOSSARY.md) is a folder: its [Service manifest](../../GLOSSARY.md) `service.json`, `handlers.ts` written with `@opsiforce/external-service-sdk`, the `service.types.ts` that `external-service-cli types` generates from the manifest, its [Service skill](service-skill.md) `SKILL.md`, its tests and an optional `README.md` and icon. The platform owns every route, guard and check in front of it, so a service declares no path, permission or migration ([ADR-0046](../adr/0046-an-external-service-is-a-manifest-and-handlers-behind-routes-the-platform-owns.md)).
- Every service has one layout, built-in or custom, small or large: `handlers.ts` only wires the manifest's names to functions in `src/`, which holds `client.ts` (the outside system: base URL, auth, error mapping, pagination, rate limits), `bounds.ts` (indirect-id checks), `operations/<area>.ts` (one per capability area), `forms.ts` (options, info, buttons), `hooks.ts` (save hooks) and `inbound.ts` (signature check and Event mapping), each only when the service has that part; `test/` mirrors `src/`, with recorded payloads in `test/fixtures/`. The platform reads only `service.json`, the icon and `handlers.ts`'s default export, so the layout is a convention the [External Service Builder](external-service-builder.md)'s `external-service-authoring` skill teaches and the built-ins follow.
- A [Built-in External Service](../../GLOSSARY.md) is that folder committed under `external-services/<slug>/`: `incoming-email`, `whatsapp` and `public-api` today. The backend image ships the folders, and at boot the backend loads each with the same check as `external-service-cli check --built-in`, refusing to boot on one that fails, carries a stale `service.types.ts` or takes a reserved name (`usage`, `webhooks`, `agent`, `admin`, `services`); adding one is [Add an external service](../operations/add-an-external-service.md).
- A [Custom External Service](../../GLOSSARY.md) has the same folder as the `app/` of its builder Project, with the SDK vendored as a tarball ([External Service Builder](external-service-builder.md)); committing that folder under `external-services/` makes it a built-in.

### What `service.json` declares

- The header is `"sdk": 1` (the SDK major), `displayName`, a plain `description` of at most 300 characters and an optional `icon` (SVG of at most 32 KB with no scripts or outside links; a letter avatar otherwise). There is no `name` or `version`: identity is the folder name or the custom service's slug, and Publish compares manifest hashes.
- `serviceForm` and `projectForm` are the two [Forms](configuration.md). A field is `text`, `textarea`, `number`, `toggle`, `radio`, `select`, `multiselect`, `secret`, `list` (one level, each item with a platform id), `keyValue`, `section`, `info` (`text`, `template` or a `call`) or `button`; options come from a static list, a `call` (searchable, `dependsOn` other fields) or, in a Project form, the items of a Service configuration list. Fields take `required`, `default`, `help`, `visibleWhen`, `validate` (lengths and the formats `email`, `emailOrDomain`, `url`, `hostname`, `e164`, `ipOrCidr`), `was` for a rename and, on `text` and `secret`, `generate` (`{bytes: 16–64}` or `{length: 8–64, alphabet}`, optionally `unique` on `text`).
- Each [Operation](../../GLOSSARY.md) in `operations` has a `kind` (`read`, `write` or `destructive`), a `description`, an optional `title` and `outputExample`, an `input` schema and optional `limits` (`inputBytes` up to 25 MB, default 1 MB; `timeoutSeconds` up to 300, default 30). Inputs are a JSON Schema 2020-12 subset with `type` everywhere, local `$ref`s only and no `pattern`; option callbacks and buttons are never Operations.
- `bounds` names what an input or an Event may reach: `{<name>: {path, where?, unless?}}`, where `path` is a Project form field or `list[].field`, `where` picks the list item an input pointer names and `unless` is the value that means "all". An input or Event `data` property says `"boundTo": "<name>"`; `check` refuses an undeclared bound and warns on a write or destructive Operation with nothing bound.
- `"inbound": true` and `events: {<type>: {title, description, data}}` declare what may arrive ([Event](events.md)); a built-in must bind every Event type.

### Handlers and the wire

- `export default defineHandlers<Manifest>({manifestHash, operations, options, info, buttons, hooks, inbound})` names one handler for every Operation, callback, hook and `inbound` the manifest uses; the SDK refuses to serve a folder with a missing handler or a `manifestHash` from another manifest.
- A handler receives the input already checked by the [Gate](gate.md), with defaults filled, and a `ctx`: `serviceConfiguration` (each `secret` a `Secret` whose JSON and string forms read `[secret]`), `projectConfiguration` without the reserved keys, `bounds` (`has`, `assert`, `filter`, `values`), `caller`, `callId`, `webhookUrl`, `signal`, `log`, `file()` for a one-file answer, and `state`, the service's own key/value store. `ctx.platformApi` exists only in the `public-api` built-in ([Public API built-in](public-api.md)).
- An answer is JSON (200) or one file. `throw new ServiceError({status, code, detail})` answers a problem with status 400, 404, 409, 422, 429 or 502 (any other becomes 502), `rateLimited` and `upstreamUnauthorized` are ready-made ones, and any other throw is `502 service-failed` with the `callId` and no stack.
- The wire is `POST /_service/{operations|options|info|buttons|hooks}/<name>` and `POST /_service/inbound`, each body carrying a `context`, plus `GET /_service/health` (the `sdk` major, the full `sdkVersion`, the manifest hash and the handler names). A context's `caller.via` is any string (`agent`, `app` or `form` today) and unknown context keys are dropped, so a newer Gate never fails an older 1.x pod. Every request needs the pod's own `service` key as `x-opsiforce-gate` and may name the manifest hash it expects in `x-opsiforce-expected-manifest` (another hash is answered `503 service-reloading` before any handler runs), and every answer carries the manifest hash in `x-opsiforce-manifest`; a built-in answers the same wire in process.

### The SDK

- `@opsiforce/external-service-sdk` is what a service imports: `defineHandlers` and the handler types, the manifest types and `checkServiceManifest`, `Secret`, `ServiceError` and the bounds' `ALL`; a test pins that list. `/server` is the `/_service/*` server; `/testing` `testService`, which runs the Gate's own Operation checks before a handler under `node:test`, hands it only the referenced Service configuration list items and withholds an answer echoing a sent secret, as the Gate does; `/openapi` the generator. The platform alone imports `/forms` (the form helpers the web app needs, without Ajv) and `/platform` (what only the platform uses: Operation admission, the bounds checker, list trimming, the echoed-secret check, the handler time limits and the test report schema); neither is in the tarball's exports.
- The tarball pins `zod` and `ajv` to the installed versions and is byte-for-byte reproducible (sorted entries, fixed times and owner). A pull request that changes `external-service-sdk/src/` must also change the SDK version, its `CHANGELOG.md` and `agent-config/agent-image-version.json`; CI refuses it otherwise. `external-service-sdk/test/compat/` keeps the compiled runtime of each released version and replays the Gate's current requests against it (one golden per route, written by the backend's `wire-snapshots.test.ts`), and checks every manifest an earlier release accepted still passes `checkServiceManifest`.
- `external-service-cli` is `check [--built-in]`, `types`, `generate --from-openapi <file|URL>` (one Operation per route of an existing OpenAPI 3 document, plus the route table a generic handler replays), `dev` (serve on `$APP_PORT`, regenerating types on change), `serve` and `report --from <lines.json>` (the test report the Publish dialog reads).

## Edge cases

- When a built-in's `service.json` fails its check or its `service.types.ts` is stale, the backend refuses to boot and names the problem.
- When a handler answers with a status `ServiceError` does not allow (401, 403, 500), the caller receives 502 with the handler's `code`.
- When `dev` or `serve` starts without `SERVICE_GATEWAY_API_KEY`, it refuses to start.

## Code

- `external-service-sdk/` — the manifest schema and check, the handler runtime and `/_service/*` server, the test kit and `external-service-cli`; `test/compat/` the compatibility corpus and frozen runtimes.
- `external-services/` — the Built-in External Service folders, one per slug, and their tests (`yarn workspace @opsiforce/external-services test`).
- `backend/src/external-services/registry/` — loading built-in folders at boot, the `external_services` rows and resolving a slug.

## Related

- [Gate](gate.md) — the checks every Operation call passes before a handler runs.
- [Configuration](configuration.md) — what the platform does with the two Forms.
- [Event](events.md) — what happens to what `inbound` returns.
- [External Service Builder](external-service-builder.md) — how a Custom External Service is written, tested and published.
- [Add an external service](../operations/add-an-external-service.md) — the steps for a new built-in.
