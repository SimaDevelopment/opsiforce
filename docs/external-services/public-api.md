---
kind: explanation
adrs: [0087]
---

# Public API built-in

> How does a pod reach the platform's own `/api/v1` as the `public-api` Built-in External Service, and which routes and writes does its Project configuration open?

## How it works

- `public-api` ("Opsiforce Public API") is an SDK 2 [Built-in External Service](../../GLOSSARY.md) in `external-services/public-api/`, loaded at every backend boot like the others. Its `service.json` declares only its identity and its Project form; its `service.ts` declares no routes of its own ([ADR-0087](../adr/0087-the-public-api-is-a-built-in-external-service-that-api-v1-itself-serves-and-pods-reach-it-only-through-its-service-host.md)).
- It is the only way a pod reaches `/api/v1`: the pod calls the real paths on the Service host, `https://public-api.$EXTERNAL_SERVICES_HOST/api/v1/...`, with its Gateway Key in a header. The Gate's caller lane forwards the call into the backend's built-ins adapter with a Caller identity signed with `public-api`'s derived built-ins key, and the adapter's pipeline refuses *not connected* (no Project configuration) or *not supported* (no matching route) before anything else runs.
- The service's routes are the `/api/v1` handlers marked `@ServiceRoute({ summary, allowedBy, counts? })`, found at boot (`PublicApiService`, `external-services/built-ins/public-api-service.ts`): one route per handler, pattern `METHOD /api/v1/<controller path>/<handler path>`, literal segments ahead of parameters. `/.well-known/opsiforce` on the Service host lists them with their summary and `allowedBy`. A route without the decorator answers `404` *not supported* to a Caller identity, so a new route stays closed to pods until someone decorates it. 26 routes are open: 10 reads and 16 writes.
- A decorated route's handler replays the request in process on the backend's own Fastify instance (`inject`) with a fresh Caller identity in `X-Opsiforce-Caller` and only `content-type`, `accept`, `user-agent`, `if-match` and `if-none-match` of the caller's headers, so the answer is `/api/v1`'s own: status, headers and body unchanged, including its `application/problem+json` refusals.
- `PublicApiGuard` takes `X-Opsiforce-Caller` as the `caller-identity` source beside IdP bearers: the signature with `public-api`'s built-ins key, `exp`, a `call` naming a ProjectEnvironment; then it resolves the creator as [ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md) says. A token minted for another built-in, an expired one and a Gateway Key on `/api/v1` all answer `401 unauthenticated`. The guard also refuses an undecorated route to a Caller identity. The main host's nginx clears incoming `X-Opsiforce-Caller` (with `-Expected-Manifest`) on `/api` and `/api/proxy`, so only the Gate's forward carries one.
- Connected (a saved Project configuration) means reads. The Project form adds five toggles, all off in a new configuration: *Edit Agents and Skills* (`authorSkillsAndAgents`: create, duplicate and version Skills; edit an Agent, its profile, Template and Skills), *Create Agents* (`createAgents`), *Create Projects* (`createProjects`) with *Created Projects limit* (`maxCreatedProjects`, default 5, shown while Create Projects is on), *Manage created Projects* (`driveCreatedProjects`: connect, restart, Test Project update and reset) and *Delete created Projects* (`deleteCreatedProjects`). Each write's `allowedBy` names one of them. Which rows a write reaches stays containment's.
- A write whose setting is off answers `403` with `Opsiforce-Outcome: not allowed` and `Opsiforce-Setting: <key>`, in the API's problem shape (`type …:permission-denied`), its `detail` naming the setting, the link to it in the Project dialog and "Someone who can configure this Project's External Services can change it." *Not connected* and *incomplete* are the same problem with their own outcome; *not supported* is `route-not-found`.
- *Created Projects limit* counts every Project whose `created_by_project_id` is the calling Project and that still exists, of any kind (Test Projects included) and disabled or not; only a delete frees a slot. The count runs inside the create's transaction with the calling Project's row locked, so parallel creates never pass the cap. At the cap `POST /projects` answers `409 max-created-projects`: "This Project may create at most 5 Projects (Opsiforce Public API → Created Projects limit). Delete one you created, or ask someone who can configure this Project's External Services to raise it." The depth-two chain stop (`409 chain-too-deep`) is checked first and the Organization Projects limit after, both unchanged. A configuration without the field counts against 5.
- The runtime proxy accepts a pod's `service` key for a child's runtime only while the caller's `public-api` configuration has *Manage created Projects* on, read on every request ([Connection](../public-api/connection.md)).
- Every Caller-identity request is a row in the built-ins Call log and counts `requests` (and `not_allowed`/`failed`) in the built-ins Usage table, written by the adapter like incoming email's ([Call log](call-log.md)). A 2xx `POST /projects` also counts `projects_created`; a 2xx `POST /skills`, `POST /skills/:id/versions` or `POST /skills/:id/duplicate` counts `skill_versions_published`. A human's IdP-bearer call never reaches the adapter and is not recorded.
- Opening a new Skill & Agent Builder chat writes its `public-api` configuration before its first delivery (`builderChatPublicApiSettings`): *Edit Agents and Skills*, *Create Projects* (Max 5) and *Manage created Projects* on, *Create Agents* and *Delete created Projects* off, so the chat has `service-public-api` from its first message. An External Service Builder chat gets none; an Agent gets the skill only when an editor adds it ([Service skill](service-skill.md)).
- Migration `0080_public-api-settings` mapped every stored `operations` map once: a setting is on when any of its old Operations was on (*Author* = the nine Skill and Agent writes, *Create Agents* = `create_agent`, *Create Projects* = `create_project`, *Drive* = connect, restart and the two Test Project calls, *Delete* = `delete_project`), *Created Projects limit* 5, and the `operations` and `receive` keys dropped. Migration `0081_sdk-1-removed` maps an Agent's `public-api` Service settings the same way (their old `operations` list), and drops every other service's switches on Agents.
- Its Service skill, `service-public-api`, teaches the API (Opsiforce Public API v1, docs at `/api/v1/docs` on the main host), how a pod's call differs from a person's, and how to relay refusals; the Skill & Agent Builder's `scripts/api.sh <METHOD> <path> [json]` is the shell form ([Skill & Agent Builder](../agent-system/skill-agent-builder.md)).

## Edge cases

- When a pod's Project has no recorded creator, `/api/v1` answers `401 unauthenticated`; when the creator left the Organization, `403 tenant-forbidden`.
- A creator's permissions are read at each call: a route needing a permission the creator lost answers `403 permission-denied` without `Opsiforce-Outcome`.
- `/api/v1/openapi.json` and `/api/v1/docs` are not decorated, so the Service host answers them *not supported*; read them on the main host.

## Code

- `external-services/public-api/` — the manifest (identity and Project form), `service.ts` and the Service skill.
- `backend/src/external-services/built-ins/public-api-service.ts` — the decorated routes, the settings check, the in-process replay, the problem-shaped refusals and the counters.
- `backend/src/external-services/configuration/public-api-settings.ts` — a ProjectEnvironment's five settings and Max, and the Builder chat's starting values.
- `backend/src/public-api/auth/` — `@ServiceRoute` and the guard that accepts a Caller identity.
- `backend/src/project/project-limit.ts` — the *Created Projects limit* cap, checked inside the create.
- `backend/db/migrations/0080_public-api-settings.sql` — the one-time `operations` mapping.

## Related

- [API Token](../public-api/api-token.md) — who an Agent Caller acts as and what it may touch.
- [Public API contract](../public-api/contract.md) — the `/api/v1` routes behind the service.
- [Skill & Agent Builder](../agent-system/skill-agent-builder.md) — the Agent that uses it most.
