# The public API is its own `public-api` module with `/api/v1` URI versioning and an additive-only compatibility policy

The internal API grew with the UI: no validation layer, no OpenAPI, no error shape, tenant selection by header, routes shaped by whatever screen needed them. External consumers need the opposite: a small surface whose every route is documented, validated, versioned and promised to keep working. Growing that out of the internal controllers would spread public promises across code that must stay free to change.

**The public API is a separate Nest module tree, `backend/src/public-api/`**, with one sub-module per resource (`me`, `agents`, `projects`, `skills`) plus `auth`, `errors` and `validation`. It reuses the domain services underneath but owns its controllers, DTO schemas, mappers, guard, pipe, serializer and exception filter. NestJS URI versioning supplies `/api/v1` (default `VERSION_NEUTRAL` so nothing else moves); no `v1` appears in folder names. Inside the module, zod schemas are the single seam: one schema per DTO drives the validation pipe, the response serializer and the OpenAPI document, which is generated at runtime, scoped by an explicit module `include` list, and served publicly with Scalar at `/api/v1/docs` and `/api/v1/openapi.json`. Errors follow RFC 9457 with URN types (rationale in [contract.md](../public-api/contract.md)). An Error carries extension members a caller branches on instead of parsing `detail`, which is prose and not part of the contract: `errors` (validation failures, by pointer and location), `organizations` (the choices behind an ambiguous Organization) and `permission` (the one that was missing).

The **compatibility policy** consumers read is the one the module enforces:

- The major version is in the path.
- Within v1, changes are additive only: new routes, optional fields, query parameters, event kinds and enum values. Consumers ignore what they do not recognise.
- A field is never removed or retyped within v1; a deprecated field is marked in the spec and keeps working for the life of v1.
- Breaking changes ship as `/api/v2` alongside v1.
- The policy covers **platform-owned resources** — `me`, Agents, Skills, Projects, environments, the connection descriptor and the Error catalogue. The opencode surface reached through `/api/proxy/{environmentId}` is not versioned by it: it is the protocol of the deployed build, published as a tested client/runtime pairing ([ADR-0038](0038-chat-is-native-opencode-through-the-runtime-proxy.md), [opencode-bump.md](../operations/upgrade-opencode.md)). Pinning a client alone does not protect a consumer from a server change; builds follow the platform's rollout.

## Considered options

- **Decorate the internal controllers and expose them.** Rejected: public promises would attach to code the UI needs to change weekly, and the internal API has no validation or serialization to promise with.
- **Header or query versioning.** Rejected: the path is visible in every log, curl and SDK, and URI versioning is what NestJS supports natively for the whole tree.
- **A committed OpenAPI snapshot with a breaking-change gate.** Not built: valuable, but a CI concern; runtime generation is the source of truth.
- **A separate deployable service.** Rejected: the API needs the same domain services, pod plumbing and tenant resolution; a module boundary gives the isolation without a second deployment.

## Consequences

- The internal API can keep evolving with the UI; only `public-api/**` carries external promises.
- Every public DTO is authored twice conceptually (schema and mapper) and once in code; the mapper is where internal shape changes are absorbed.
- Enum growth is legal, so consumers written against v1 must treat unknown values as "other"; the docs say so.

## The Fastify adapter

- **The module owns the process's Fastify adapter.** Nest takes one adapter for the application, so `public-api` supplies it and scopes the *behaviour* instead. The empty-body allowance, which lets a bodiless `POST` be sent by a client that always sends `content-type: application/json`, is gated on the request path and changes nothing outside `/api/v1`. The original Fastify error is kept as `cause`, so a malformed body reaches the filter as a validation failure rather than a bare 400; the status and message are the framework's own, so no internal response changes.
- **Every request carries a generated id.** The adapter is built with `requestIdHeader: false` and a UUID `genReqId`, because an Error's `instance` and the `X-Request-Id` header must be an id the platform minted rather than one a caller could supply and forge. This applies to internal requests too, where the id reaches the logs and nothing else.
