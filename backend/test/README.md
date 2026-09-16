# Backend tests

`yarn workspace @opsiforce/backend run test` runs Vitest against a throwaway Postgres and a fake
opencode pod. Docker must be running; there is no CI wiring — these tests are local only. The
narrative version of this lives in [docs/backend/testing.md](../../docs/backend/testing.md).

`setup/global-setup.ts` starts one Testcontainers Postgres for the whole run, applies the Drizzle
migrations to it, and then clones that migrated database once per worker (`CREATE DATABASE …
TEMPLATE`). `setup/env.ts` picks the clone matching its `VITEST_POOL_ID` and puts that connection
string in `DATABASE_URL` before any test file imports `db/index.ts`, whose Drizzle client is a module
singleton created at import time. Test files therefore run in parallel across workers without seeing
each other's rows. `setup/global-setup.ts` reads Vitest's own resolved `maxWorkers` to decide how many
clones to create, so the clone count and the worker count cannot drift; `vitest.config.mts` is the one
place that sets it.

## Where things live

Tests are grouped by the area they drive, one directory deep — today `public-api/`, with the tests for
other areas flat at the root until one of them reaches three files. Nothing test-shaped lives under
`src/`. The rules and the reasoning are [ADR 0037](../../docs/adr/0037-backend-tests-are-grouped-by-area-under-test-never-under-src.md);
what follows is where to actually put a new file.

A `support/` directory holds anything a test imports that is not itself a test: harnesses, fakes, data
builders and small utilities. There are two of them, and a helper's home is decided by which tests can
**reach** it, not by what it is named. `test/support/` is for helpers reachable from outside
`public-api/`, including transitively — which is why `proxy-identity.ts` lives there even though every
direct importer is a public-API test: `project-fixtures.ts` imports it, and `agent-session.test.ts`
imports that. `test/public-api/support/` is for the rest. So `../support/…` in an import reaches a
shared helper and `./support/…` an area-local one; a helper in `test/support/` importing one from an
area is the direction that would be wrong.

## The Postgres helper

`createDomainTestingModule()` returns a harness over a Nest testing module of the real domain
services — `ProjectService`, `WorkspaceService`, `UserService`, `EnvironmentService`,
`ProjectEnvironmentService`, `TenantService`, `AgentService`, `GatewayKeyService`, the
`agent-session` module (`harness.agentSessions` is the gateway) and their Postgres-backed
collaborators, reading and writing real tables. Permissions are pure functions over
the oauth2-proxy headers (`src/permission/permission.utils.ts`) plus `PermissionGuard`, which the
module provides.

Faked, because they leave the process: Kubernetes (`PodService`, `PodCacheService`,
`ProjectAuthService`), Redis (`TimeoutService`, `ProjectEventsService`, the BullMQ queues) and the
HTTP services (`BifrostService`, `ExternalServiceProvisioningService`, `ScheduleService`,
`ProjectPoolService`). Every fake records what it was called with:
`harness.fakes.pods.callsTo('createAssignedPod')`.

Pod startup is gated rather than instant. `FakePodService.waitForReady()` returns a promise that
settles only when a test calls `markPodReady(podName)` or `failPodStartup(podName, error)`, so a
freshly created Project stays deterministically in `starting` until the test decides otherwise.

Two things to know before writing a test:

- Each worker has its own database, but the files that worker runs share it, so scope fixtures to a
  fresh tenant rather than assuming empty tables. `organizationName()` and `serviceAccountUsername()`
  mint UUID-backed names, which stay unique across workers as well as within one.
- Assert on what _your_ project or session did, not on a cumulative total. Project creation finishes
  after its HTTP response returns, so a previous test's pod can still be provisioning when the next
  one reads a global counter — filter `callsTo(...)` by `projectId` instead.
- The harness lists its providers explicitly instead of importing `ProjectModule` and friends. The
  real modules pull in BullMQ, bull-board and the Kubernetes client at construction, so importing
  them would mean standing up Redis. The cost is that module-level wiring is not exercised here and
  the provider list needs a line whenever a domain service gains a dependency.

## The public-API app

`createPublicApiTestApp()` boots a Nest Fastify application over `PublicApiModule` with the real
domain services behind it, the same UUID request ids, global prefix and URI versioning `main.ts`
sets up, and the two global guards production registers: `TenantGuard` then `PermissionGuard`, with
`PublicApiGuard` running after them on the public controllers. Requests go in through
`app.inject()`, so nothing listens on a socket.

There is no bearer token to forge: oauth2-proxy verifies the token and the backend only ever sees
the headers it forwards. `proxyHeaders()` in `support/proxy-identity.ts` builds them — user id,
preferred username, email and the `x-forwarded-groups` roles that carry both Organization
membership and permissions — and defaults to a single-Organization human caller holding
`can_use_public_api`. `organizationName()` and `serviceAccountUsername()` mint fresh names, which
matters because the run shares one database and an Organization row is created on first sight.
Static mode needs no special app: it is the same headers with the deployment's fixed permission
list.

## The fake pod

`startFakePod()` serves the opencode routes a connection and a probe need — the ordered, limited root
list, session get, create and delete, `/api/health`, `session/active` — plus the prompt, message,
wait, interrupt and inbox routes and the `/api/event` stream that native transport tests still use,
with in-memory state and the response envelopes from the vendored spec at
`frontend/opencode/packages/protocol/openapi.json`. Anything else answers 404. Errors use opencode's
own `_tag` envelopes, built by `podErrors` (`SessionNotFoundError`, `InvalidRequestError`,
`InvalidCursorError`, `ConflictError`, `UnknownError`, `ServiceUnavailableError`) so that later
tickets map real shapes to Errors.

```ts
pod.script('session.get', { delayMs: 300 }); // slow pod
pod.script('session.prompt', { status: 409, body: podErrors.conflict('busy'), once: true });
pod.replayToNewStreams([{ event: 'server.connected', data: {} }]); // sent to each new stream
pod.emit({ id: '2', event: 'session.text.delta', data: { text: 'hi' } }); // pushed to every open stream
pod.endStreams(); // clean end (FIN)
pod.closeStreams(); // abrupt drop (dead pod)
```

`pod.requests` records every request it received — route, method, path, query, headers, parsed body —
including query parameters the fake does not otherwise act on, so a test can assert on them.

**It never fakes the pod client.** The backend's own HTTP client, timeouts, SSE parsing and error
mapping always run for real against this server; that is the point of using a socket instead of a mock.

## The recorded opencode payloads

`fixtures/opencode/` holds real opencode response bodies. They no longer pin a platform-owned schema —
chat is native opencode through the runtime proxy, so the platform publishes no chat shapes to
pin ([ADR-0038](../../docs/adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md)). They stay
as realistic payloads for the fake runtime and as a record of what a build actually emitted; see
[the bump runbook](../../docs/operations/upgrade-opencode.md) and the note beside the fixtures.
