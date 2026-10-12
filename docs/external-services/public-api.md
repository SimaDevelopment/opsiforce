---
kind: explanation
adrs: [0087]
---

# Public API built-in

> How does a pod reach the platform's own `/api/v1` as the `public-api` Built-in External Service, and where do its Operations come from?

## How it works

- `public-api` ("Opsiforce Public API") is a [Built-in External Service](../../GLOSSARY.md) in `external-services/public-api/`, loaded at every backend boot like the others. Its Service form is empty, so it is always [Available](../../GLOSSARY.md), and it has no inbound ([ADR-0087](../adr/0087-the-public-api-is-a-built-in-external-service-and-pods-reach-it-only-through-the-gate.md)).
- It is the only way a pod reaches `/api/v1`: the pod calls `POST $EXTERNAL_SERVICES_URL/public-api/<operation>` with its `service` key, and the [Gate](gate.md) checks the call like any other, so its Project configuration's switches decide which Operations it may call and every call is in the [Call log](call-log.md). `/api/v1` answers 401 to a Gateway Key.
- Its [Operations](../../GLOSSARY.md) are the `/api/v1` routes marked `@ExternalServiceOperation('<snake_case name>', {kind?})`, which also sets the route's `operationId`. The kind follows the HTTP method (GET read, DELETE destructive, the rest write) except where the decorator overrides it: `validate_skill` is a read, `remove_agent_skill` a write and `reset_test_project` destructive.
- `service.json`, `openapi-routes.json` and `service.types.ts` are generated from the backend's own OpenAPI document by `external-service-cli generate --from-openapi`: one flat input per Operation from the route's path, query and body fields. They are committed, and `test/external-services/public-api-manifest.test.ts` fails when a decorated route drifts from them (`vitest run … -u` regenerates them).
- The handler is the generic table any wrapped OpenAPI service uses, built from `openapi-routes.json` in `src/operations/routes.ts`; `src/client.ts` rebuilds the request with `openApiRouteRequest(routes[operation], input)` and sends it to `ctx.platformApi.url`, the backend on loopback, with `ctx.platformApi.token`. That token is a single-use `gc-` call token the Gate holds in memory, issues only to the in-process `public-api` built-in, accepts only on the `/api/v1` route whose Operation it was issued for and revokes when the call ends; `PublicApiGuard` resolves it to the calling Project and acts as an [Agent Caller](../../GLOSSARY.md) ([API Token](../public-api/api-token.md)).
- A refusal from `/api/v1` keeps its `code` and `detail`; its status passes through when the SDK allows it (400, 404, 409, 422, 429) and becomes 502 otherwise, so a 401, 403, 423 or 503 reaches the pod as 502 with the same code.
- A new Project configuration starts with the reads on and the writes off ([Configuration](configuration.md)). A Skill & Agent Builder chat's is written when the Builder opens the chat, before its first delivery, with every read and fourteen writes on (authoring, Test Project and `connect_project`; `create_agent` and `delete_project` stay off), so the chat has `service-public-api` from its first message; an Agent gets the skill only when an editor adds it ([Service skill](service-skill.md)). A new Operation is off in every existing Project configuration.
- The runtime proxy accepts the same `service` key for a child's runtime while the pod's `connect_project` switch is on, read on every request ([Connection](../public-api/connection.md)).
- Its Service skill, `service-public-api`, teaches the flat input, describe before planning and the refusals; the Skill & Agent Builder's `scripts/api.sh call <operation>` is the shell form of the same call ([Skill & Agent Builder](../agent-system/skill-agent-builder.md)).
- The upgrade's migration gives every existing `skill-agent-builder` ProjectEnvironment with no `public-api` Project configuration the one a new chat starts with, and leaves one that has a configuration as it is; the boot pass then delivers its Service skill. A Custom Agent has the Public API only when an editor adds `service-public-api` on the Agent page and its Projects enable `public-api`.

## Edge cases

- When the backend's HTTP server has no address yet, the handler gets no `ctx.platformApi` and answers `502 platform-api-unreachable`.
- When a pod's Project has no recorded creator, `/api/v1` answers 401 and the pod receives a 502 carrying that refusal's code.
- When a Project at the chain depth limit calls `create_project`, it gets `409 chain-too-deep`.

## Code

- `external-services/public-api/` — the generated manifest and route table, `handlers.ts`, `src/client.ts` (the platform call and its refusals), `src/operations/routes.ts` (the Operation table) and the Service skill.
- `backend/src/public-api/auth/` — `@ExternalServiceOperation` and the guard that accepts call tokens.
- `backend/src/gateway/call-tokens.ts` — the in-memory call tokens.
- `backend/src/external-services/gate/platform-api-grant.ts` — the `ctx.platformApi` grant the Gate asks for on each Operation call, given only to the in-process `public-api`.
- `backend/src/builder/builder-chat.service.ts` — the writes a new Skill & Agent Builder chat starts with switched on.

## Related

- [API Token](../public-api/api-token.md) — who an Agent Caller acts as and what it may touch.
- [Public API contract](../public-api/contract.md) — the `/api/v1` routes behind the Operations.
- [Gate](gate.md) — the checks every call passes.
- [Skill & Agent Builder](../agent-system/skill-agent-builder.md) — the Agent that uses it most.
