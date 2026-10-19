# @opsiforce/external-service-sdk

The SDK every External Service is written against, Built-in or Custom. A service is a transparent proxy in front of an upstream API with a policy: callers use the upstream's own API and clients through the service's Service host, and the service's checks decide what passes. A service is a folder:

| File | What it is |
| --- | --- |
| `service.json` | The Service manifest: `"sdk": 2`, display name, description, icon, `inbound`, the Service form, the Project form and the Event types (a title and a description each). There are no Operations, bounds or `$defs`. |
| `service.types.ts` | Generated from `service.json` by `external-service-cli types`. Never edit it; commit it. |
| `service.ts` | `export default defineService<Manifest>({ manifest, routes, counters, options, info, buttons, hooks, webhook, background, refusal })`. |
| `icon.svg` | Optional, at most 32 KB, no scripts and no outside links. |

What the platform relies on is [WIRE-CONTRACT.md](WIRE-CONTRACT.md).

## Routes

Service routes are built with `route('<METHOD>[|<METHOD>…] <path>' | '* <path>', { summary, allowedBy, check, to | handle, through, bodyLimit })` and upstreams with `upstream({ name, api, url, mount, credentials })`. The first route whose pattern matches a request decides; a request no route matches is refused *not supported*.

- `to: upstream` passes the request through byte for byte, with the caller's credentials stripped and the upstream's own added. Unsafe paths are refused before any route.
- `handle(request, ctx)` answers the request itself; an answer holding a Service-configuration secret is refused as failed.
- `through(request, ctx, forward)` reads or narrows a proxied answer.
- Every route names in `allowedBy` the Project-form settings that govern it (`[]` when none does, a refuse route and an `allowAll` route included).
- Every route that passes or handles a request has a `check` (or `check: allowAll`). A check answers `ctx.allow()`, `ctx.notAllowed({ setting, message })` or `ctx.notSupported(message)`; anything else fails closed.

Bodies and answers stream untouched unless a check, `through` or `handle` reads them (`bodyLimit`, 10 MB by default). Every refusal carries `Opsiforce-Outcome` (and `Opsiforce-Setting` for a setting), and one `refusal()` override shapes the body.

## Entry points

- `@opsiforce/external-service-sdk`: what a service imports. `defineService`, `route`, `upstream`, `allowAll`, the route, handler and `ctx` types, the manifest types and `checkServiceManifest`, `Secret` and `sdkVersion` (the major).
- `@opsiforce/external-service-sdk/server`: Node only. `createServiceHttpServer`, the records file, the Caller identity, `computeManifestHash` and `sdkPackageVersion`.
- `@opsiforce/external-service-sdk/testing`: Node only, for `node:test`. `testService(service, options)`.
- `@opsiforce/external-service-sdk/service-folder`: Node only. `checkServiceFolder` and `readServiceFolder`.
- `@opsiforce/external-service-sdk/service.schema.json`: the manifest's JSON Schema, for editors.

The platform's own code also imports `/forms` (the form helpers its web app needs) and `/platform` (what only the platform uses, like the test report schema). Neither is in the tarball's exports, so no service can depend on them.

## The request context

A Service route's `ctx` has:

- `ctx.caller`: the Caller identity (`kind`, the Organization, Project, ProjectEnvironment and environment). Every request carries one, signed with the pod's own key; a request without a valid one is refused *unidentified* and gets no Call log row.
- `ctx.projectConfiguration` and `ctx.serviceConfiguration`, with `secret` fields as `Secret` objects (`secret.reveal()` gives the value; JSON, `String()` and logs print `[secret]`). A request from a Project that is not connected, or whose Project configuration misses a required field, is refused before any route.
- `ctx.missingServiceFields`: the required Service-form fields the Service configuration lacks. The SDK refuses nothing for them; a route that cannot work without one refuses itself.
- `ctx.params`: the route pattern's `:name` segments.
- `ctx.state`: a key-value store of JSON values kept in `/workspace/data/service-state.db`, with `update(key, change)` atomic per key. A Built-in has none.
- `ctx.service`: the service as a whole (`configuration()`, `projectConfigurations()`, `deliver()`, `count()`, `state`, `webhookUrl`, the copy's Webhook address from `$SERVICE_WEBHOOK_URL`).
- `ctx.count(name, n)` adds to a declared counter, `ctx.note(fields)` adds fields to this request's Call log row.

Form calls and save hooks run named handlers, never routes: `options: { name: (draft, ctx) => [{ value, label }] }`, `info`, `buttons` and `hooks: { onServiceConfigurationSaved, onProjectConfigurationSaved }`. `draft` is `{ form, values, query?, item? }`; `ctx.serviceConfiguration` is the draft itself for a Service-form call, so `upstream.fetch(ctx, …)` tests the values just typed. `webhook(request, ctx)` answers the service's Webhook address when `"inbound": true`; `service.deliver(event, { to })` stores Events for the ProjectEnvironments it names.

## Records

The service writes `/workspace/data/service-records.db` itself: one Call log row per identified request (outcome, route, status, sizes, duration, notes; pruned after 30 days) and the Usage counters (`requests`, `not_allowed`, `failed`, `events` and up to 20 declared in `counters`, never pruned). The platform only reads the file.

## The CLI

`external-service-cli` runs in the service's folder:

- `check`: checks `service.json` and the icon, printing every error and warning. Exits 1 on an error.
- `types`: writes `service.types.ts` from `service.json`.
- `dev`: serves the folder on `$APP_PORT`, rewriting the types and restarting on every change.
- `serve`: serves the folder without reloading.
- `report --from <lines.json>`: writes the test report the Publish dialog reads.

`dev` and `serve` read their configurations from `$SERVICE_GATEWAY_URL` with `SERVICE_GATEWAY_API_KEY`, take `service.webhookUrl` from `$SERVICE_WEBHOOK_URL`, never time a request out, and refuse to start when `service.ts` defines the service with a manifest other than `service.json`.

## Testing

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testService } from '@opsiforce/external-service-sdk/testing';
import service from '../service.ts';

test('reads an issue on an allowed repository', async () => {
  const kit = testService(service, {
    serviceConfiguration: { token: 'test-token' },
    projectConfiguration: { repositories: [{ id: 'r1', name: 'acme/app', access: 'read' }] },
    upstreams: { api: () => Response.json({ number: 1 }) },
  });

  const answer = await kit.fetch('/repos/acme/app/issues/1');

  assert.equal(answer.status, 200);
});
```

`testService` runs the real in-memory server with a valid Caller identity, so a refusal in a test is the refusal a caller gets. `upstreams` answers each upstream by name; `kit.service` is the service handle and `kit.deliveries` the Events delivered.

## Versions

A Custom External Service carries this SDK as a tarball in `vendor/`, named with its version, and runs that version until someone upgrades it. The tarball pins `zod` to the exact version the SDK was tested with, and packing the same source twice gives the same bytes. The platform serves every `2.x`. See `CHANGELOG.md` for what each version adds.

Releasing a version: bump `version`, add its `CHANGELOG.md` entry and bump `agent-config/agent-image-version.json` (CI refuses a change under `src/` without all three).
