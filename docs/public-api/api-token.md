---
kind: explanation
terms: [API Token, Gateway Key, Agent Caller]
adrs: [0034, 0062]
---

# API Token

> Who calls the public API, how does a program sign in, and which [Organization](../../GLOSSARY.md) does a call act in?

## How it works

- The public API serves a program acting for a user or an Organization: the command line tool, a chat integration relaying a group's messages, a schedule or webhook that wakes an Agent, another [Agent](../../GLOSSARY.md) building on this one. Its platform half is small, identity, Agents, Skills, [Projects](../../GLOSSARY.md) and [Connection](connection.md), because the conversation is opencode's own API.
- An [API Token](../../GLOSSARY.md) is the bearer token the deployment's identity provider issues when that user or service account signs in; oauth2-proxy verifies it and forwards the same identity headers the browser path uses, and the platform stores nothing for it ([ADR-0034](../adr/0034-public-api-callers-are-idp-bearer-tokens-behind-a-caller.md)).
- A program holds exactly the Organization memberships and permissions its owner has in the UI, plus the entry permission `can_use_public_api` that admins carry by default; that permission gates `/api/v1` only ([Permissions](../organization/permissions.md)).
- The runtime path's agent surface is gated by Organization membership and Project visibility, exactly as for the browser, and cannot tell a program from a user — except for a pod's `service` key, which it resolves to the Project's creator, narrows to the Projects that pod created, and admits only while the `connect_project` switch of the pod's `public-api` Project configuration is on, read on every request: the runtime proxy never caches a pod's answer ([Connection](connection.md), [ADR-0087](../adr/0087-the-public-api-is-a-built-in-external-service-and-pods-reach-it-only-through-the-gate.md)). A Project carrying a `kind` adds a third gate on both paths: a [Builder chat](../../GLOSSARY.md) and the Test Project it runs admit their creator and whoever may see the Skill or Agent the chat authors ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)). The Code and DB surfaces run none of these gates, and the App's hostname does not pass the platform's identity proxy and is guarded per environment by App Auth instead ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- A [Gateway Key](../../GLOSSARY.md) is the per-ProjectEnvironment `gw-` token a pod holds: one `service` key for Schedules, External Services, the runtime proxy and platform pushes. Presented to `/api/v1` it answers 401.
- The `public-api` [Built-in External Service](../../GLOSSARY.md) is the only way a pod reaches `/api/v1`: the Gate checks the pod's call like any other Operation, and the in-process handler calls `/api/v1` on loopback with a single-use `gc-` call token valid only on the route of the Operation it was issued for ([Public API built-in](../external-services/public-api.md)). The guard resolves it to the calling Project and acts as an [Agent Caller](../../GLOSSARY.md) — the human who created that Project, with that human's permissions as the platform last saw them. `can_use_public_api` does not apply to it; every per-route permission still does ([ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md), [ADR-0087](../adr/0087-the-public-api-is-a-built-in-external-service-and-pods-reach-it-only-through-the-gate.md)).
- Which Operations a pod may call is its Project configuration's switches, reads on and writes off until the Project switches them on, a builder chat's written with its writes on ([Public API built-in](../external-services/public-api.md)).
- An Agent Caller reaches only the routes marked `@ExternalServiceOperation`, which are the `public-api` Operations — `GET /me`, `GET /agents`, Create, List, Get, Connect, Restart and Delete for Projects, and Update and Reset for a Test Project — and only Projects carrying its own id in `createdByProjectId`; anything else is 404. Skills and Custom Agents are read creator-wide, but written only when they are the calling builder chat's subject or carry its id in `created_by_project_id`, which a Skill or Agent it creates (or duplicates) is stamped with; any other write answers `permission-denied`, so a prompt-injected `pdf-tools` chat cannot publish a version of `invoices`. `GET /me` reports `source: call-token` so an Agent can say whose authority it is using, and for a Builder chat's pod `builderSubject`, the one Skill or Agent that chat authors, and `builderTestProject`, the chat's one Test Project once it exists.
- The opt-in list also carries the authoring routes the [Skill & Agent Builder](../../GLOSSARY.md) needs: reading, validating, creating, renaming and duplicating a [Skill](../../GLOSSARY.md) and publishing a [Skill Version](../../GLOSSARY.md); reading a [Custom Agent](../../GLOSSARY.md), creating one, renaming and describing it, editing its Development profile, and setting its [Agent Skills](../../GLOSSARY.md). The destructive and widening verbs, and Duplicate (Agent), have no `/api/v1` route to open ([Public API contract](contract.md)).
- A call resolves to nothing when its Project has no recorded creator; that answers 401. The chain of Projects a pod may start is capped at depth 2: Create a Project from a Project at the cap answers `409 chain-too-deep`.
- The guard resolves the platform user once per request, so every route sees one caller carrying both the identity provider subject and the platform user id.
- The Organization a call acts in is chosen with the `x-tenant-name` header the UI also sends, and the contract calls it a tenant throughout ([ADR-0034](../adr/0034-public-api-callers-are-idp-bearer-tokens-behind-a-caller.md)): a caller in exactly one Organization sends nothing; one in several names one or receives an [Error](contract.md) listing the choices.
- A service account is an ordinary user with two differences: it gets no [Personal Workspace](../../GLOSSARY.md), and its new Projects land in the [Public Workspace](../../GLOSSARY.md) unless a Workspace is named ([Workspaces](../organization/workspaces.md)).
- There is no discovery route: a client learns how a deployment authenticates from the deployment, not from the API.

## Edge cases

- In standalone static mode no login exists, and the API is anonymous-admin and network-trusted like the rest of that mode ([Local orchestration](../operations/local-orchestration.md)).
- In that mode a pod's call token still resolves through the same hop, against the one platform user the deployment has.
- A pod reaches a child's runtime at `OPSIFORCE_RUNTIME_PROXY_URL`, the backend setting `runtimeProxyUrl` naming the agent runtime-proxy Service directly, without the identity proxy in front, exactly as `SERVICE_GATEWAY_URL` already does; without it a pod gets no such variable.
- Projects that predate provenance have no `created_by`, so their pods' `public-api` calls answer 401. Skills and Agents a builder chat created before the upgrade carry no `created_by_project_id`, so only their own chat (as subject) can write them.

## Code

- `backend/src/public-api/auth/` — the guard, the caller, Organization resolution and `@ExternalServiceOperation`.
- `backend/src/gateway/call-tokens.ts` — the in-memory `gc-` call tokens the Gate issues.
- `backend/src/public-api/me/` — who the token is and which Organizations it may act in.
- `backend/src/proxy/proxy.controller.ts` — the runtime ensure hop, which accepts a person or a pod's `service` key with `connect_project` on.
- `backend/src/store/calling-project.ts` — the Skill and Agent write containment for a pod.

## Related

- [Connection](connection.md) — the step between having a Project and talking to it.
- [Public API contract](contract.md) — the resources, Errors and compatibility policy.
- [Permissions](../organization/permissions.md) — how permissions flow from the identity provider.
- [Workspaces](../organization/workspaces.md) — where a service account's Projects land.
- [Public API built-in](../external-services/public-api.md) — the External Service a pod calls to reach `/api/v1`.
