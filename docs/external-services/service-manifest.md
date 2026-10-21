---
kind: explanation
terms: [External Service, Built-in External Service, Service manifest, Service policy]
adrs: [0046, 0082, 0095]
---

# Service manifest

> What is an External Service made of, what does its `service.json` declare, and what does the SDK give the code behind it?

## How it works

### The folder

- An [External Service](../../GLOSSARY.md) is a folder: its [Service manifest](../../GLOSSARY.md) `service.json`, `service.ts` written with `@opsiforce/external-service-sdk`, the `service.types.ts` that `external-service-cli types` generates from the manifest, its [Service skill](service-skill.md) `SKILL.md`, its tests and an optional `README.md` and icon. The service owns its API and its [Service policy](../../GLOSSARY.md): the platform lets a call through or refuses it only on who is calling and which service is addressed ([Gate](gate.md), [ADR-0046](../adr/0046-an-external-service-owns-its-api-and-its-service-policy-the-gate-only-identifies-the-caller-finds-the-service-and-forwards-the-call-untouched.md)).
- A Custom service's layout is the one the [External Service Builder](external-service-builder.md)'s template lays and its `external-service-authoring` skill teaches: `service.ts`, `src/upstreams.ts`, one `src/groups/<group>.ts` per pass-through group and `test/groups/<group>.test.ts`. The platform reads only `service.json`, the icon and `service.ts`'s default export.
- A [Built-in External Service](../../GLOSSARY.md) is that folder committed under `external-services/<slug>/`: `incoming-email`, `whatsapp` and `public-api` today. The backend image ships the folders, and at boot the backend loads each from its `service.ts` default export, whose manifest must be its `service.json`, with the same check as `external-service-cli check`, refusing to boot on one that fails or takes a reserved name (`usage`, `webhooks`, `agent`, `admin`, `services`); adding one is [Add an external service](../operations/add-an-external-service.md). `public-api` declares no routes: `/api/v1` itself serves its Service host ([Public API built-in](public-api.md)).
- A [Custom External Service](../../GLOSSARY.md) has the same folder as the `app/` of its builder Project, with the SDK vendored as a tarball ([External Service Builder](external-service-builder.md)); committing that folder under `external-services/` makes it a built-in.

### What `service.json` declares

- The header is `"sdk": 2` (the SDK major), `displayName`, a plain `description` of at most 300 characters and an optional `icon` (SVG of at most 32 KB with no scripts or outside links; a letter avatar otherwise). There is no `name` or `version`: identity is the folder name or the custom service's slug, and Publish compares manifest hashes. `operations`, `bounds` and `$defs` are refused: what a request may do is the routes' checks.
- `serviceForm` and `projectForm` are the two [Forms](configuration.md). A field is `text`, `textarea`, `number`, `toggle`, `radio`, `select`, `multiselect`, `secret`, `list` (one level, each item with a platform id, `id` reserved inside items), `keyValue`, `section`, `info` (`text`, `template` or a `call`) or `button`; options come from a static list, a `call` (searchable, `dependsOn` other fields) or, in a Project form, the items of a Service configuration list. Fields take `required`, `default`, `help`, `visibleWhen`, `validate` (lengths and the formats `email`, `emailOrDomain`, `url`, `hostname`, `e164`, `ipOrCidr`), `was` for a rename and, on `text` and `secret`, `generate` (`{bytes: 16–64}` or `{length: 8–64, alphabet}`, optionally `unique` on `text`).
- `"inbound": true` and `events: {<type>: {title, description}}` declare what may arrive; an Event's data is never declared or validated ([Event](events.md)).
- `"connectedByDefault": true` connects every new Project to the service while it is Available, as if a person had saved its Project form untouched; a service whose Project form needs a person's choice leaves it out ([Configuration](configuration.md), [ADR-0095](../adr/0095-a-service-manifest-can-connect-every-new-project-to-the-service.md)).

### Routes and the request context

- `export default defineService<Manifest>({ manifest, routes, counters, options, info, buttons, hooks, webhook, background, refusal })` defines the service. `routes` is an ordered table of `route('<METHOD>[|<METHOD>…] <path>' | '* <path>', { summary, allowedBy, check, to | handle, through, bodyLimit })`; the first match decides, and a request no route matches is refused *not supported* ([ADR-0082](../adr/0082-an-external-service-declares-the-routes-it-serves-in-its-own-code-and-agents-learn-it-from-an-authored-skill-and-the-service-itself.md)).
- `to: upstream({ name, api, url, mount, credentials })` passes the request through byte for byte with the caller's credentials stripped and the upstream's own added; `handle(request, ctx)` answers it itself, and an answer holding a Service-configuration secret is refused as failed; `through` reads or narrows a proxied answer. Every route names in `allowedBy` the Project-form settings that govern it (`[]` when none does), and every route that passes or handles a request has a `check` (or `check: allowAll`) answering `ctx.allow()`, `ctx.notAllowed({ setting, message })` or `ctx.notSupported(message)`; anything else fails closed. Bodies stream untouched unless a check, `through` or `handle` reads them (`bodyLimit`, 10 MB by default).
- A request's `ctx` holds `caller` (the verified Caller identity), `projectConfiguration` and `serviceConfiguration` (each `secret` a `Secret` whose JSON and string forms read `[secret]`), `params`, `state`, `missingServiceFields` (the required Service-form fields the Service configuration lacks, which refuse nothing by themselves), `service` (`configuration()`, `projectConfigurations()`, `deliver()`, `count()`, `state`, `webhookUrl` from `SERVICE_WEBHOOK_URL`), `count(name, n)` and `note(fields)`. A request from a Project that is not connected, or whose Project configuration misses a required field, is refused before any route.
- Every refusal carries `Opsiforce-Outcome` (and `Opsiforce-Setting` for a setting); `refusal()` shapes the body. `GET /.well-known/opsiforce` answers the routes, their summaries and settings and the caller's Project configuration ([Service skill](service-skill.md)).
- `options`, `info`, `buttons` and `hooks` (`onServiceConfigurationSaved`, `onProjectConfigurationSaved`) answer only the platform's [form calls and save hooks](configuration.md) under `/.well-known/opsiforce/`, never a Service route; `webhook` answers the service's Webhook address ([Event](events.md)). The wire, including the records file, is `external-service-sdk/WIRE-CONTRACT.md`.

### The SDK

- `@opsiforce/external-service-sdk` is what a service imports: `defineService`, `route`, `upstream`, `allowAll`, the route, handler and `ctx` types, the manifest types and `checkServiceManifest`, `Secret` and `sdkVersion`; a test pins that list. `/server` is `createServiceHttpServer`, the records file and the Caller identity; `/testing` is `testService(service, options)`, whose `fetch` runs the real in-memory server with a valid Caller identity, so a refusal in a test is the refusal a caller gets; `/service-folder` reads and checks a folder. The platform alone imports `/forms` (the form helpers the web app needs) and `/platform` (what only the platform uses, like the test report schema); neither is in the tarball's exports.
- The tarball pins `zod` to the installed version and is byte-for-byte reproducible (sorted entries, fixed times and owner). A pull request that changes `external-service-sdk/src/` must also change the SDK version, its `CHANGELOG.md` and `agent-config/agent-image-version.json`; CI refuses it otherwise. The platform serves every `2.x`.
- `external-service-cli` is `check`, `types`, `dev` (serve on `$APP_PORT`, regenerating types and restarting on change), `serve` and `report --from <lines.json>` (the test report the Publish dialog reads).

## Edge cases

- When a built-in's `service.json` fails its check, the backend refuses to boot and names the problem. Nothing checks `service.types.ts` at boot: regenerate it with `external-service-cli types` after every manifest change.
- When `service.ts` defines the service with a manifest other than `service.json`, `dev` and `serve` refuse it (`check` reads only the folder's `service.json`), and the backend refuses to boot on such a built-in.
- When `dev` or `serve` starts without `SERVICE_GATEWAY_API_KEY`, it refuses to start.
- When a manifest says `"sdk": 1` or still declares `operations`, `check` refuses it, and a published one is built on SDK 1 ([External Service Builder](external-service-builder.md)).

## Code

- `external-service-sdk/` — the manifest schema and check, the service runtime and server, the records file, the test kit and `external-service-cli`.
- `external-services/` — the Built-in External Service folders, one per slug, and their tests (`yarn workspace @opsiforce/external-services test`).
- `backend/src/external-services/registry/` — loading built-in folders at boot, the `external_services` rows and resolving a slug.

## Related

- [Gate](gate.md) — how a call reaches the service's routes.
- [Configuration](configuration.md) — what the platform does with the two Forms.
- [Event](events.md) — what happens to what `deliver()` hands over.
- [External Service Builder](external-service-builder.md) — how a Custom External Service is written, tested and published.
- [Add an external service](../operations/add-an-external-service.md) — the steps for a new built-in.
