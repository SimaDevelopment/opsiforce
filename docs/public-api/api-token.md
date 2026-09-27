---
kind: explanation
terms: [API Token, Gateway Key, Agent Caller]
adrs: [0034, 0062]
---

# API Token

> Who calls the public API, how does a program sign in, and which [Organization](../../CONTEXT.md) does a call act in?

## How it works

- The public API serves a program acting for a user or an Organization: the command line tool, a chat integration relaying a group's messages, a schedule or webhook that wakes an Agent, another [Agent](../../CONTEXT.md) building on this one. Its platform half is small, identity, Agents, Skills, [Projects](../../CONTEXT.md) and [Connection](connection.md), because the conversation is opencode's own API.
- An [API Token](../../CONTEXT.md) is the bearer token the deployment's identity provider issues when that user or service account signs in; oauth2-proxy verifies it and forwards the same identity headers the browser path uses, and the platform stores nothing for it ([ADR-0034](../adr/0034-public-api-callers-are-idp-bearer-tokens-behind-a-caller.md)).
- A program holds exactly the Organization memberships and permissions its owner has in the UI, plus the entry permission `can_use_public_api` that admins carry by default; that permission gates `/api/v1` only ([Permissions](../organization/permissions.md)).
- The runtime path's agent surface is gated by Organization membership and Project visibility, exactly as for the browser, and cannot tell a program from a user — except for a pod's gateway key, which it resolves the same way `/api/v1` does and then narrows to the Projects that pod created ([Connection](connection.md)). A Project carrying a `kind` adds a third gate on both paths: a [Builder chat](../../CONTEXT.md) and the Test Project it runs admit their creator and whoever may see the Skill or Agent the chat authors ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)). The Code and DB surfaces run none of these gates, and the App's hostname does not pass the platform's identity proxy and is guarded per environment by App Auth instead ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- A [Gateway Key](../../CONTEXT.md) is the per-ProjectEnvironment `gw-` token a pod holds, carrying a purpose: every pod has a `service` key for Schedules, external services and platform pushes. A pod whose Agent declares the capability holds a second one of purpose `platform-api` and calls `/api/v1` as an [Agent Caller](../../CONTEXT.md) — the human who created its Project, with that human's permissions as the platform last saw them. `can_use_public_api` does not apply to it; every per-route permission still does ([ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)).
- An Agent Caller reaches only the routes marked `@AllowsGatewayCaller()` — today `GET /me`, `GET /agents`, Create, List, Get, Connect, Restart and Delete for Projects, and Update and Reset for a Test Project — and only Projects carrying its own id in `createdByProjectId`; anything else is 404. `GET /me` reports `source: gateway-key` so an Agent can say whose authority it is using, and for a Builder chat's pod `builderSubject`, the one Skill or Agent that chat authors, and `builderTestProject`, the chat's one Test Project once it exists.
- The opt-in list also carries the authoring routes the [Skill & Agent Builder](../../CONTEXT.md) needs: reading, validating, creating, renaming and duplicating a [Skill](../../CONTEXT.md) and publishing a [Skill Version](../../CONTEXT.md); reading a [Custom Agent](../../CONTEXT.md), creating one, renaming and describing it, editing its Development profile, and setting its [Agent Skills](../../CONTEXT.md). The destructive and widening verbs, and Duplicate (Agent), have no `/api/v1` route to open ([Public API contract](contract.md)).
- A key resolves to nothing when its Project has no recorded creator or its row carries no Organization; both answer 401. The chain of Projects a pod may start is capped at depth 2: a Project at the cap is created without a `platform-api` key.
- The guard resolves the platform user once per request, so every route sees one caller carrying both the identity provider subject and the platform user id.
- The Organization a call acts in is chosen with the same organization header the UI sends: a caller in exactly one Organization sends nothing; one in several names one or receives an [Error](contract.md) listing the choices.
- A service account is an ordinary user with two differences: it gets no [Personal Workspace](../../CONTEXT.md), and its new Projects land in the [Public Workspace](../../CONTEXT.md) unless a Workspace is named ([Workspaces](../organization/workspaces.md)).
- There is no discovery route: a client learns how a deployment authenticates from the deployment, not from the API.

## Edge cases

- In standalone static mode no login exists, and the API is anonymous-admin and network-trusted like the rest of that mode ([Local orchestration](../operations/local-orchestration.md)).
- In that mode a pod's gateway key still resolves through the same hop, against the one platform user the deployment has.
- A pod reaches the API at `OPSIFORCE_API_URL` and a child's runtime at `OPSIFORCE_RUNTIME_PROXY_URL` — backend settings (`platformApiUrl`, `runtimeProxyUrl`) naming the backend and the agent runtime-proxy Services directly, without the identity proxy in front, exactly as `SERVICE_GATEWAY_URL` already does. Neither has a default: an environment that mints a `platform-api` key without both refuses to start the pod rather than hand it a base URL that resolves nowhere.
- Projects that predate provenance have no `created_by`, so their pods can hold no `platform-api` key.

## Code

- `backend/src/public-api/auth/` — the guard, the caller and Organization resolution.
- `backend/src/public-api/me/` — who the token is and which Organizations it may act in.
- `backend/src/proxy/proxy.controller.ts` — the runtime ensure hop, which accepts both credential kinds.

## Related

- [Connection](connection.md) — the step between having a Project and talking to it.
- [Public API contract](contract.md) — the resources, Errors and compatibility policy.
- [Permissions](../organization/permissions.md) — how permissions flow from the identity provider.
- [Workspaces](../organization/workspaces.md) — where a service account's Projects land.
