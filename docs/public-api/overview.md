# Public API

> Programmatic access to Opsiforce for the CLI, integrations and other Agents: identity, the Agent registry, Projects, and a connection to a Project's Agent runtime. The platform API is served under `/api/v1` and documented live at `/api/v1/docs`; the conversation itself is native opencode, reached through `/api/proxy/{environmentId}`. Decisions: [ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md) (native chat and the connection), [ADR-0034](../adr/0034-public-api-callers-are-idp-bearer-tokens-behind-a-caller.md) (callers), [ADR-0035](../adr/0035-public-api-module-with-uri-versioning-and-additive-compat.md) (module and compatibility), [ADR-0036](../adr/0036-agent-session-is-the-backends-only-door-to-a-pods-opencode-port.md) (backend pod access).

## Who it is for

A program acting for a user or an Organization: the command line tool, a chat integration that relays a group's messages, a schedule or webhook that wakes an Agent, another Agent building on this one. Each of those consumers is its own effort; the API is the surface they share. The platform half is deliberately small — identity, Agents, Projects, connection — because the conversation is opencode's own API, spoken with opencode's own client.

## Signing in as a program

A caller sends the bearer token the deployment's identity provider issues when that user, or that service account, signs in. The platform stores nothing for this: oauth2-proxy verifies the token and forwards the same identity headers the browser path uses, so a program holds exactly the Organization memberships and permissions its owner has in the UI, plus the entry permission `can_use_public_api` that admins carry by default. That permission gates `/api/v1` only: the runtime path is gated by Organization membership and Project visibility, exactly as it is for the browser, and cannot tell a program from a user. In standalone `static` mode no login is needed and the API is anonymous-admin, network-trusted like the rest of that mode. There is no discovery route: a client learns how a deployment authenticates from the deployment, not from the API. The guard resolves the platform user once per request, so every route sees one `Caller` carrying both the IdP subject and the platform user id.

The Organization the call acts in is chosen with the same organization header the UI sends. A caller who belongs to exactly one Organization sends nothing; one who belongs to several either names one or receives an Error listing the choices. A service account is an ordinary user to the platform with two differences: it gets no Personal workspace, and its new Projects land in Public unless a workspace is named.

## What you can reach

`/me` is who the token is and which Organizations it may act in. `/agents` is the read-only registry of Agent profiles a Project can be created with. `/projects` lists, creates and deletes Projects the caller can see, with every ProjectEnvironment and its status; creation is asynchronous, so a new Project answers immediately with its Development environment still starting, and the caller polls or streams. Deleting needs the permission `can_delete_project`, which the same effort added to the internal delete route too, so the two surfaces gate it alike. Lists paginate by cursor from day one. Anything the caller may not see is a plain not-found; the API never confirms that a hidden Project exists.

## Talking to the Agent

The conversation is not a platform resource. Each ProjectEnvironment's runtime is opencode, and a program talks to it the way the browser does: through `/api/proxy/{environmentId}`, with opencode's own paths, bodies, responses, defaults and event framing. Nothing is re-shaped, filtered or renamed on the way through. [ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md) records why, and what that costs.

**Connect first.** `POST /api/v1/projects/{id}/environments/{environmentId}/connect` is the one step between having a Project and talking to it. It checks that the caller can see the Project and that the environment belongs to it, wakes the environment if it is asleep, resolves and remembers the primary Session the app and every program share, and reads the build the runtime reports. It answers:

```json
{ "baseUrl": "/api/proxy/<environmentId>",
  "openapiUrl": "/api/proxy/<environmentId>/openapi.json",
  "sessionId": "ses_...",
  "build": "1.18.4" }
```

`build` is what the ready runtime said during this connection, and `null` if it does not identify one. A 200 means a usable connection now — not a promise the environment will not restart.

**The URLs are origin-relative.** Resolve them against the origin you already called the platform on, and send your bearer token only to that origin. The platform never reads a `Host` header to build them, so the same descriptor works in a hosted, local or standalone deployment.

**Discovery without connecting.** Every environment in a Project answers with the same three fields under `opencode`, from metadata alone — no pod is touched and nothing is woken. There `sessionId` is the remembered binding, `null` until a first connection makes one. Use it to notice that a Project has never been connected, not as a readiness signal.

**Waking is bounded.** A connection spends one budget of thirty seconds on waking, locking and talking to the pod. An environment still starting when it runs out is a `503` `environment-starting` Error with `Retry-After: 5` — retry, rather than treating it as a failure. A disabled environment is `423`, a failed one `503 environment-failed`, and a pod that is ready but unreachable is a `502`/`504` rather than being mislabelled as startup.

**Then it is opencode.** Prompt, read messages, stream events, wait, interrupt, browse the inbox — all against `baseUrl` with the session id from the descriptor, in opencode's own shapes. Four things follow from that being native:

- **`wait` means the Session went idle**, not that a particular prompt succeeded. There is no per-prompt outcome; read the result from the messages or from the events.
- **The event stream is opencode's**, unfiltered and unreframed. It has no replay: reconnect and resync from the message list, the same as before.
- **Delivery defaults to opencode's `steer`.** A program that means "next turn" asks for `queue` explicitly.
- **Reads can wake an environment** and touch its activity, because the proxy path ensures the environment on the way in.

**Retrying safely.** Send your own `id` on a prompt whenever the caller might run twice — a webhook delivered more than once, a retry after a lost response. The runtime answers the first admission again for the same id with the same body, and conflicts on a different one. That is what makes replaying an ambiguous prompt correct: replay it with the *same* id and body, never a fresh one. Do not blanket-retry every write on a 503; interruption and deletion have their own semantics.

**Reconnecting.** An environment that restarts, or a token that expires, means connecting again. The descriptor is cheap to re-fetch and the Session id is stable across reconnects, so resynchronising is: connect, then read messages from the last id you saw.

**What the runtime lets you do.** Reaching a runtime is environment-level access. It includes the filesystem and shell, session mutation, model switching and integration or credential operations — not prompt-only access. Grant it the way you would grant access to the Project in the app, because it is the same grant.

**Reading the runtime's API.** The docs page carries both halves. `/api/v1/docs` opens on the Platform API and offers a second document, *Agent Runtime (opencode)*, served from the spec vendored alongside the runtime source at `frontend/opencode/packages/protocol/openapi.json` — the same snapshot the deployed image runs, so it can be browsed without waking anything. The platform gives it a `servers` entry of `/api/proxy/{environmentId}`, a variable the reader fills in, so the page's own request buttons reach a real environment. That snapshot is a convenience, not the contract: the authoritative document for a running environment is still the `openapiUrl` `connect` reports, served by that pod at that build. The two move together only because [the bump runbook](opencode-bump.md) moves the image pin and the vendored tree in one change; if the docs page and a pod ever disagree, the pod is right.

**A client and an example.** [`example/`](example/) is a runnable consumer: it pins the client package against the runtime build, resolves discovery URLs against a known origin, and supplies the small fetch adapter the generated client needs (it builds `new URL(path, baseUrl)`, which discards a path prefix — upstream `anomalyco/opencode#46498`). It exercises connect, prompt, events, messages, wait and interrupt over HTTP and SSE. WebSocket and PTY compatibility is not claimed.

## When something fails

Every failure **on `/api/v1`** is an Error: a stable `type` URN a program can branch on, a fixed title for that kind, a `detail` written for the caller, and the request id as `instance`, echoed in `X-Request-Id` so support can find the call. Four extension members let a caller act on a failure rather than parse it out of prose: a rejected request and an unknown reference both list their `errors` by pointer and location, an ambiguous Organization lists the `organizations` to choose from, and a denial names the `permission` that was missing.

Failures on `/api/proxy/{environmentId}` are not platform Errors. They are opencode's own errors, or the edge's and the proxy's: a missing or expired bearer is a `401` from oauth2-proxy, and a starting or restarting environment is a `503` the proxy generates with `Retry-After: 5`. A generated client turns a status it does not declare into an opaque `UnexpectedStatus`, so read the retry guidance in your transport, before that conversion.

Two choices behind that shape are worth remembering. Types are URNs rather than URLs because a deployment-independent identifier must not promise a page that each self-hosted instance would have to serve. And a 4xx raised inside a reused domain service keeps its message as `detail`, since it was written for a user, while anything 5xx is walled off to a generic detail, since it was written for an operator.

## How the contract evolves

The major version is in the path. Within v1 changes are additive only: new routes, optional fields, query parameters, event kinds and enum values. Consumers ignore what they do not recognise, including enum values they have not seen. A field is never removed or retyped within v1; a deprecated field is marked in the spec and keeps working for the life of v1. Breaking changes ship as `/api/v2` alongside v1.

The policy covers platform-owned resources only. The opencode surface behind `baseUrl` is the protocol of the deployed build: it moves when the platform rolls out a new agent image, and pinning a client version does not protect you from a server change. Treat the client and the runtime as a pairing you verify together.

## Where it is built

The API is a separate module tree in the backend, `public-api`, with one sub-module per resource and shared auth, errors and validation pieces, reusing the domain services underneath. One zod schema per DTO is the single seam: it validates the request, serializes the response, and produces the OpenAPI 3.1 document at runtime, served at `/api/v1/openapi.json` and rendered by Scalar at `/api/v1/docs`; neither needs a token. The DTO schemas are strict on both sides — an unrecognised request field is a validation Error rather than being ignored, and a response the server cannot serialise against its own schema fails loudly rather than leaking a field. NestJS 12's native Standard Schema support made this possible without a bridging library, which is why the backend moved to Nest 12 before the API was built; the alternative, a third-party zod adapter pinned below zod 4.5, would have frozen the repo's zod version for a dependency the framework now covers. There is no committed spec snapshot yet; the running server is the source of truth until a breaking-change gate is added.

The API brings its own Fastify adapter, which the whole process then runs on, carrying the two concessions the framework does not make for us. It keeps the original Fastify error as the `cause`, so a malformed body reaches the error filter as a validation failure rather than a bare 400; the status and message it produces are the framework's own, so nothing outside the API sees a different answer. And it replaces the JSON body parser with one that lets an empty body through, gated on the path. That second one exists so a bodiless POST — `connect` — can be sent by a plain HTTP client that always sets `content-type: application/json`; outside `/api/v1` an empty JSON body is still the error it always was.

The backend's own calls into a pod's opencode port go through the `agent-session` module, which owns the wake hold, the reload gate, the primary-Session binding and the failure report, and hands out typed errors the API maps to its own Errors. Consumer traffic does not go through it: the browser and a program both reach opencode through the Go proxy, which ensures the environment, stamps prompts and touches activity for what it carries. The proxy authorizes that path by asking the backend, forwarding the edge's trusted identity so the answer is the same predicate the Project list uses.

## When opencode is upgraded

Consumers speak the deployed build's protocol directly, so a new opencode build in the agent image changes what they see. Follow [the bump runbook](opencode-bump.md).
