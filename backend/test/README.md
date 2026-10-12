# Backend tests

`yarn workspace @opsiforce/backend run test` runs Vitest against a throwaway Postgres and a fake
opencode pod. Docker must be running; there is no CI wiring — these tests are local only. The
narrative version of this lives in [docs/backend/testing.md](../../docs/backend/testing.md).

`setup/global-setup.ts` starts one Testcontainers Postgres for the whole run, applies the Drizzle
migrations to it, installs the platform model providers an existing deployment gets from its cutover
(`openai`, `anthropic`, `custom-openai-1`, from `support/cutover-platform-providers.ts`; a fresh
migration inserts none), and then clones that database once per worker (`CREATE DATABASE …
TEMPLATE`). `setup/env.ts` picks the clone matching its `VITEST_POOL_ID` and puts that connection
string in `DATABASE_URL` before any test file imports `db/index.ts`, whose Drizzle client is a module
singleton created at import time. Test files therefore run in parallel across workers without seeing
each other's rows. `setup/global-setup.ts` reads Vitest's own resolved `maxWorkers` to decide how many
clones to create, so the clone count and the worker count cannot drift; `vitest.config.mts` is the one
place that sets it.

## Where things live

Tests are grouped by the area they drive, one directory deep — today `public-api/`, `store/`,
`delivery/`, `agent-update/`, `model-provider/`, `linked-accounts/` and `external-services/`, with the tests for other areas
flat at the root until one of them reaches three files. Nothing test-shaped lives under
`src/`. The rules and the reasoning are [ADR 0037](../../docs/adr/0037-backend-tests-are-grouped-by-area-under-test-never-under-src.md);
what follows is where to actually put a new file.

A `support/` directory holds anything a test imports that is not itself a test: harnesses, fakes, data
builders and small utilities. There are two of them, and a helper's home is decided by which tests can
**reach** it, not by what it is named. `test/support/` is for helpers reachable from outside
one area, including transitively — which is why `proxy-identity.ts` lives there even though every
direct importer is a public-API test: `project-fixtures.ts` imports it, and `agent-session.test.ts`
imports that. An area's own `support/` (`test/public-api/support/`, `test/model-provider/support/`,
`test/linked-accounts/support/`, `test/external-services/support/`) is for the rest. So `../support/…` in an import reaches a
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
HTTP services (`BifrostService`, `ScheduleService`, `ProjectPoolService`). Every fake records what it
was called with: `harness.fakes.pods.callsTo('createAssignedPod')`.

Pod startup is gated rather than instant. `FakePodService.waitForReady()` returns a promise that
settles only when a test calls `markPodReady(podName)` or `failPodStartup(podName, error)`, so a
freshly created Project stays deterministically in `starting` until the test decides otherwise.

Two things to know before writing a test:

- Each worker has its own database, but the files that worker runs share it, so scope fixtures to a
  fresh tenant rather than assuming empty tables. `tenantName()` and `serviceAccountUsername()`
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
`can_use_public_api`. `tenantName()` and `serviceAccountUsername()` mint fresh names, which
matters because the run shares one database and an Organization row is created on first sight.
Static mode needs no special app: it is the same headers with the deployment's fixed permission
list.

The harness also watches what the app answers. An `onSend` hook records every
`application/problem+json` response against the route Fastify matched, and `close()` checks each one
against the `type` enum that operation declares in the document the app serves at
`/api/v1/openapi.json` — so a route that raises a Problem its `@PublicApiErrors` does not list fails
the file that provoked it, wherever that Problem came from. Ambient Problems (the guards, the pipe
and the filter raise these anywhere) are exempt, as is `ProbeController`, which is mounted on the API
but deliberately outside the document. Coverage is therefore honest rather than exhaustive: it
verifies the paths the tests exercise and says nothing about the rest.

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

## The fake Bifrost

`startFakeBifrost()` serves the Bifrost admin routes the backend calls — the provider list and
lookups, customers, teams and virtual keys — with in-memory state. It starts with the providers of
a deployment cut over from Helm (`openai`, `anthropic`, `custom-openai-1`), refuses a virtual key
that names any other with Bifrost's 400, and records every write. Boot the public-API app with its `env` and
`[BifrostService]` as the real services, and the backend's own Admin API client runs against it.

```ts
bifrost.chatKeyOf(projectId)?.provider_configs; // what the chat key routes to now
bifrost.setProviders(['openai', 'anthropic']); // which providers exist in Bifrost
bifrost.setProviderStatus('anthropic', 'error'); // the provider_status the provider list reports
bifrost.becomeUnreachable(); // every request's socket is dropped until becomeReachable()
bifrost.refuseProviderConfigWrites(keyId); // 500 on every provider_configs write to one key, or to all without an id
bifrost.providerConfigWritesTo(keyId); // the provider_configs writes a key received
bifrost.providerNamed(name)?.created; // the POST /api/providers body, and .keys the keys added to it
bifrost.addProvider(name); // a provider someone else created, e.g. another Organization's
bifrost.loseProvider(name); // the gateway loses a provider, as a wiped Bifrost database would; its key entries go too
bifrost.keepProvidersOnDelete(); // DELETE answers 200 but the provider stays, like Bifrost's swallowed failure
bifrost.requests; // every request, reads included, e.g. to see a delete confirmed with a GET
bifrost.holdVirtualKeys(ids); // the gateway also holds keys earlier files' fakes created, for a sync across every Organization
```

Created providers take keys (`POST /api/providers/{p}/keys`, names unique across providers) and key
replacements (`PUT /api/providers/{p}/keys/{id}` with the whole key), a standard name is refused with
400 when the body carries a `custom_provider_config` and created as a standard provider without one,
an existing name with 409, and a private-network or non-http(s) `base_url` with 400, on create and on
`PUT /api/providers/{p}` alike. That `PUT` upserts like Bifrost's and records its body in `.updated`;
the `https://` rule is the backend's, so the fake leaves plain http alone, as Bifrost does.

`startFakeVendorApi()` (`model-provider/support/fake-vendor-api.ts`) stands in for a vendor's API behind a Model provider's connection test. Put
its `baseUrl` per Base format in `MODEL_PROVIDER_OFFICIAL_API_URLS` (JSON), and pick its answer with
`vendor.replyWith(401 | 'redirect' | 'drop' | …)`. `vendor.servedOverHttpsAt(hostname)` returns an
`https://<hostname>/v1` base URL for a Compatible endpoint and routes the process's `fetch` for that
host to the same fake over plain http, until `vendor.close()`. Every answer carries
`VENDOR_REPLY_MARKER`, so a test can assert the reply body never reaches the browser.

`startFakeChatGptAuth()` (`linked-accounts/support/fake-chatgpt-auth.ts`) stands in for `auth.openai.com` and `chatgpt.com` behind a Linked account: it routes
the process's `fetch` for both hosts to itself over plain http, until `chatgpt.close()`. It hands out the device code `ABCD-1234`, answers device
polls as `chatgpt.replyToDevicePolls('pending' | 'rate-limited' | 'approved')` says, exchanges the code
for tokens whose access-token JWT carries `exp`, the account id and the email, and rotates the refresh
token on every refresh, refusing a spent one with `refresh_token_reused`. It counts `usercodeRequests`,
`devicePolls` and `refreshRequests`; it answers `chatgpt.com/backend-api/wham/usage` with whatever `reportUsage(payload | status)` set, 404 by default, and records each read in `usageRequests`; `issueTokensLasting(ms)` sets the next tokens' lifetime and
`delayRefreshes(ms)` holds each refresh so concurrent callers overlap. Tests that need the 5 s poll gap
or the 15-minute expiry fake only `Date` (`vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })`)
and move it with `vi.setSystemTime`.
