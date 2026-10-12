# @opsiforce/external-service-sdk

The SDK every External Service is written against, Built-in or Custom. A service is a folder:

| File | What it is |
| --- | --- |
| `service.json` | The Service manifest: display name, description, icon, the Service form, the Project form, the Operations with their input schemas and kinds, the named bounds and the Events. `"sdk": 1` names this SDK's major version. |
| `service.types.ts` | Generated from `service.json` by `external-service-cli types`. Never edit it; commit it. |
| `handlers.ts` | `export default defineHandlers<Manifest>({ manifestHash, operations, options, info, buttons, hooks, inbound })`, one handler for every name the manifest uses. |
| `icon.svg` | Optional, at most 32 KB, no scripts and no outside links. |

The platform's Gate checks every call before it reaches a handler: the caller's key, the Operation's switch in the caller's Project configuration, the input against its schema and every bounded value against the configuration. A handler receives the input already checked and with defaults filled, plus a `ctx`.

## Entry points

- `@opsiforce/external-service-sdk`: runtime-neutral, what a service imports. `defineHandlers` and the handler and `ctx` types, the manifest types and `checkServiceManifest`, `Secret`, `ServiceError`, `rateLimited`, `upstreamUnauthorized`, `problem`, `ALL` for bounds, `openApiRouteRequest` and `sdkVersion` (the major).
- `@opsiforce/external-service-sdk/server`: Node only. `createServiceRuntime`, `createServiceServer` (the `/_service/*` wire), `computeManifestHash` and `sdkPackageVersion`.
- `@opsiforce/external-service-sdk/testing`: Node only, for `node:test`. `testService(manifest, handlers, { serviceConfiguration, projectConfiguration })` gives `call`, `options`, `info`, `button`, `hook`, `inbound`, `upstream`, `state` and `logs`.
- `@opsiforce/external-service-sdk/service-folder`: Node only. `checkServiceFolder` and `readServiceFolder`.
- `@opsiforce/external-service-sdk/openapi`: Node only. `writeServiceFromOpenApi(folder, document, { origin })`, what `generate --from-openapi` runs.
- `@opsiforce/external-service-sdk/service.schema.json`: the manifest's JSON Schema, for editors.

The platform's own code also imports `/forms` (the form helpers its web app needs, without Ajv) and `/platform` (what only the platform uses: Operation admission, the bounds checker, list trimming, the echoed-secret check, the handler time limits and the test report schema). Neither is in the tarball's exports, so no service can depend on them.

## The handler context

Every handler gets `ctx` with:

- `ctx.serviceConfiguration`: the Service configuration, with `secret` fields as `Secret` objects. `secret.reveal()` gives the value; JSON, `String()` and logs print `[secret]`.
- `ctx.projectConfiguration`: the caller's Project configuration.
- `ctx.bounds`: `has`, `assert`, `filter` and `values`, the same bound checks the Gate applies, for ids the input reaches only indirectly and for filtering outputs.
- `ctx.state`: a key-value store of JSON values (keys up to 256 characters, size bounded only by the environment's storage) kept in a SQLite file in the environment's data folder, `/workspace/data/service-state.db`; `createServiceServer({ stateFile })` names another file. A Built-in has none.
- `ctx.caller`, `ctx.callId`, `ctx.webhookUrl`, `ctx.signal` (aborted when the call's time limit passes), `ctx.log` and `ctx.file()`.
- `ctx.platformApi` is `undefined` in a Custom External Service; the platform gives it only to its own Built-ins.

Throw `new ServiceError({ status, code, detail })` for an answer the caller should read; any other throw becomes `502 service-failed` without a stack.

## The CLI

`external-service-cli` runs in the service's folder:

- `check [--built-in]`: checks `service.json` and the icon, printing every error and warning. Exits 1 on an error.
- `types`: writes `service.types.ts` from `service.json`.
- `generate --from-openapi <file or URL>`: wraps an existing OpenAPI 3 API. It writes one Operation per route into `service.json` (input = the route's path, query and body fields in one flat object; kind from the method: GET read, DELETE destructive, the rest write), the route table `openapi-routes.json` and `service.types.ts`. When any route carries `x-opsiforce-operation`, only those routes become Operations, named by it, and `x-opsiforce-kind` overrides a kind. It keeps everything in an existing `service.json` but `operations` and `$defs`, and fails without writing when two routes or two input fields share a name. A handler turns an input back into the request with `openApiRouteRequest(routes[operation], input)`.
- `dev`: serves the folder on `$APP_PORT`, rewriting the types and restarting on every change.
- `serve`: serves the folder without reloading.
- `report --from <lines.json>`: writes the test report the Publish dialog reads.

`dev` and `serve` refuse to start without `SERVICE_GATEWAY_API_KEY`, a stale `service.types.ts` or a handler the manifest names but `handlers.ts` lacks. `GET /_service/health` answers the `sdk` major, the full `sdkVersion`, the manifest hash and the handler names once the service runs; every request needs the pod's own key as `x-opsiforce-gate`.

## Testing

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testService } from '@opsiforce/external-service-sdk/testing';
import manifest from '../service.json' with { type: 'json' };
import handlers from '../handlers.ts';

test('reads a card on an allowed board', async () => {
  const service = testService(manifest, handlers, {
    serviceConfiguration: { apiKey: 'test-key' },
    projectConfiguration: { boardIds: ['B1'], operations: { get_card: true } },
  });
  service.upstream.reply('GET https://api.example.com/cards/C1', { id: 'C1', boardId: 'B1' });

  const answer = await service.call('get_card', { cardId: 'C1' });

  assert.equal(answer.status, 200);
});
```

`call` runs the Gate's own Operation checks first, so a refusal in a test is the refusal a caller gets. Like the Gate, every call hands the handler only the Service configuration list items the Project configuration picks, and an answer that contains a secret the call carried is withheld as `502 secret-in-response`. `upstream.reply` answers `fetch`; a request no reply answers fails the test. `hook('onProjectConfigurationSaved', …)` and a Project form call (`options`, `info`, `button` on a `projectForm` field) give the handler `ctx.caller` built from the `caller` option, as the platform passes the caller of the environment whose configuration was saved or is being edited.

## Versions

A Custom External Service carries this SDK as a tarball in `vendor/`, named with its version, and runs that version until someone upgrades it. The tarball pins `zod` and `ajv` to the exact versions the SDK was tested with, and packing the same source twice gives the same bytes. The Gate accepts every `1.x`. See `CHANGELOG.md` for what each version adds.

Releasing a version: bump `version`, add its `CHANGELOG.md` entry and bump `agent-config/agent-image-version.json` (CI refuses a change under `src/` without all three), then run `node scripts/freeze-runtime.ts` so `test/compat/runtime-<version>/` keeps the compiled runtime. `test/compat/` replays today's Gate requests (`wire/`, written by the backend's `wire-snapshots.test.ts`) against every frozen runtime and checks that every manifest in `manifests/` is still accepted: rules may loosen, never tighten.
