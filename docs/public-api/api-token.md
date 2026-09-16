---
kind: explanation
terms: [API Token]
adrs: [0034]
---

# API Token

> Who calls the public API, how does a program sign in, and which [Organization](../../CONTEXT.md) does a call act in?

## How it works

- The public API serves a program acting for a user or an Organization: the command line tool, a chat integration relaying a group's messages, a schedule or webhook that wakes an Agent, another [Agent](../../CONTEXT.md) building on this one. Its platform half is small, identity, Agents, [Projects](../../CONTEXT.md) and [Connection](connection.md), because the conversation is opencode's own API.
- An [API Token](../../CONTEXT.md) is the bearer token the deployment's identity provider issues when that user or service account signs in; oauth2-proxy verifies it and forwards the same identity headers the browser path uses, and the platform stores nothing for it ([ADR-0034](../adr/0034-public-api-callers-are-idp-bearer-tokens-behind-a-caller.md)).
- A program holds exactly the Organization memberships and permissions its owner has in the UI, plus the entry permission `can_use_public_api` that admins carry by default; that permission gates `/api/v1` only ([Permissions](../organization/permissions.md)).
- The runtime path is gated by Organization membership and Project visibility, exactly as for the browser, and cannot tell a program from a user ([Connection](connection.md)).
- The guard resolves the platform user once per request, so every route sees one caller carrying both the identity provider subject and the platform user id.
- The Organization a call acts in is chosen with the same organization header the UI sends: a caller in exactly one Organization sends nothing; one in several names one or receives an [Error](contract.md) listing the choices.
- A service account is an ordinary user with two differences: it gets no [Personal Workspace](../../CONTEXT.md), and its new Projects land in the [Public Workspace](../../CONTEXT.md) unless a Workspace is named ([Workspaces](../organization/workspaces.md)).
- There is no discovery route: a client learns how a deployment authenticates from the deployment, not from the API.

## Edge cases

- In standalone static mode no login exists, and the API is anonymous-admin and network-trusted like the rest of that mode ([Local orchestration](../operations/local-orchestration.md)).

## Code

- `backend/src/public-api/auth/` — the guard, the caller and Organization resolution.
- `backend/src/public-api/me/` — who the token is and which Organizations it may act in.

## Related

- [Connection](connection.md) — the step between having a Project and talking to it.
- [Public API contract](contract.md) — the resources, Errors and compatibility policy.
- [Permissions](../organization/permissions.md) — how permissions flow from the identity provider.
- [Workspaces](../organization/workspaces.md) — where a service account's Projects land.
