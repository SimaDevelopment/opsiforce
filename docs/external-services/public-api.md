---
kind: explanation
adrs: [0087]
---

# Public API built-in

> How does a pod reach the platform's own `/api/v1` as the `public-api` Built-in External Service, and which routes and writes does its Project configuration open?

## How it works

- `public-api` ("Opsiforce Public API") is an SDK 2 [Built-in External Service](../../GLOSSARY.md) in `external-services/public-api/`, loaded at every backend boot like the others. Its `service.json` declares only its identity and its Project form; its `service.ts` declares no routes or options calls of its own ([ADR-0087](../adr/0087-the-public-api-is-a-built-in-external-service-that-api-v1-itself-serves-and-pods-reach-it-only-through-its-service-host.md)).
- It is the only way a pod reaches `/api/v1`: the pod calls the real paths on the Service host, `https://public-api.$EXTERNAL_SERVICES_HOST/api/v1/...`, with its Gateway Key in a header. The Gate's caller lane forwards the call into the backend's built-ins adapter with a Caller identity signed with `public-api`'s derived built-ins key, and the adapter's pipeline refuses *not connected* (no Project configuration) or *not supported* (no matching route) before anything else runs.
- The service's routes are the `/api/v1` handlers marked `@ServiceRoute({ summary, allowedBy, counts? })`, found at boot (`PublicApiService`, `external-services/built-ins/public-api-service.ts`): one route per handler, pattern `METHOD /api/v1/<controller path>/<handler path>`, literal segments ahead of parameters. `/.well-known/opsiforce` on the Service host lists them with their summary and `allowedBy`. A route without the decorator answers `404` *not supported* to a Caller identity, so a new route stays closed to pods until someone decorates it. 26 routes are open: 10 reads and 16 writes.
- A decorated route's handler replays the request in process on the backend's own Fastify instance (`inject`) with a fresh Caller identity in `X-Opsiforce-Caller` and only `content-type`, `accept`, `user-agent`, `if-match` and `if-none-match` of the caller's headers, so the answer is `/api/v1`'s own: status, headers and body unchanged, including its `application/problem+json` refusals.
- `PublicApiGuard` takes `X-Opsiforce-Caller` as the `caller-identity` source beside IdP bearers: the signature with `public-api`'s built-ins key, `exp`, a `call` naming a ProjectEnvironment; then it resolves the creator as [ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created-or-names.md) says. A token minted for another built-in, an expired one and a Gateway Key on `/api/v1` all answer `401 unauthenticated`. The guard also refuses an undecorated route to a Caller identity. The main host's nginx clears incoming `X-Opsiforce-Caller` (with `-Expected-Manifest`) on `/api` and `/api/proxy`, so only the Gate's forward carries one.
- Connected (a saved Project configuration) means reads. The Project form adds five toggles, all off in a new configuration: *Edit Skills and Agents* (`authorSkillsAndAgents`: create, duplicate and version Skills; edit an Agent, its profile, Template and Skills), *Create Agents* (`createAgents`) with *Agent limit* (`maxCreatedAgents`, default 5), *Create Projects* (`createProjects`) with *Allowed Agents* (`createdProjectAgents`), *Workspace for new Projects* (`createdProjectsWorkspace`) and *Project limit* (`maxCreatedProjects`, default 5), *Open and restart Projects* (`driveCreatedProjects`: connect, restart, Test Project update and reset, for created and Other Projects alike), and *Delete Projects* (`deleteCreatedProjects`). A setting under a toggle shows only while that toggle is on. Each write's `allowedBy` names one toggle. What the settings under *Create Agents* and *Create Projects* allow is [Created Projects and Agents](created-projects-and-agents.md). Which rows a write reaches stays containment's.
- *Other Projects* (`otherProjects`, a searchable multiselect of at most 100, empty in a new configuration) names ordinary Projects the pod reaches besides the ones it created, on `/api/v1` and the runtime proxy alike. It lists and reads them, connects to and restarts them while *Open and restart Projects* is on, and never deletes them (`403 permission-denied`).
- The picker's `otherProjectChoices` options call is answered in the backend: up to 50 Projects the calling Project's creator can see, newest first and matched on title, leaving out the calling Project and the Projects it created. Each choice is labelled with its title and its Workspace, or Public for a Project in no Workspace. On an Agent's Service settings there is no calling Project, so it offers the ordinary Projects of the person configuring the Agent in that Organization: the call carries the asking Organization in its Caller identity and the person only inside the backend, never to a custom service. A new Project of that Agent still reaches only the picked Projects its own creator can open.
- A write whose setting is off answers `403` with `Opsiforce-Outcome: not allowed` and `Opsiforce-Setting: <key>`, in the API's problem shape (`type …:permission-denied`), its `detail` naming the setting, the link to it in the Project dialog and "Someone who can configure this Project's External Services can change it." *Not connected* and *incomplete* are the same problem with their own outcome; *not supported* is `route-not-found`.
- The runtime proxy accepts a pod's `service` key for the runtime of a Project the caller created or lists under *Other Projects*, only while the caller's `public-api` configuration has *Open and restart Projects* on, read on every request. A Caller identity gets `baseUrl` and `openapiUrl` absolute on `OPSIFORCE_RUNTIME_PROXY_URL`, from Connect and under every Project's `opencode`, since this Service host answers `/api/proxy/...` *not supported* ([Connection](../public-api/connection.md)).
- Every Caller-identity request is a row in the built-ins Call log and counts `requests` (and `not_allowed`/`failed`) in the built-ins Usage table, written by the adapter like incoming email's ([Call log](call-log.md)). A 2xx `POST /projects` also counts `projects_created`; a 2xx `POST /skills`, `POST /skills/:id/versions` or `POST /skills/:id/duplicate` counts `skill_versions_published`. A human's IdP-bearer call never reaches the adapter and is not recorded.
- Opening a new Skill & Agent Builder chat writes its `public-api` configuration before its first delivery (`builderChatPublicApiSettings`): *Edit Skills and Agents*, *Create Projects* (Max 5) and *Open and restart Projects* on, *Create Agents* and *Delete Projects* off, *Other Projects*, *Allowed Agents* and *Workspace for new Projects* empty, both limits 5, so the chat has `service-public-api` from its first message. An External Service Builder chat gets none; an Agent gets the skill only when an editor adds it ([Service skill](service-skill.md)).
- Migration `0080_public-api-settings` mapped every stored `operations` map once: a setting is on when any of its old Operations was on (*Author* = the nine Skill and Agent writes, *Create Agents* = `create_agent`, *Create Projects* = `create_project`, *Drive* = connect, restart and the two Test Project calls, *Delete* = `delete_project`), *Project limit* 5, and the `operations` and `receive` keys dropped. Migration `0081_sdk-1-removed` maps an Agent's `public-api` Service settings the same way (their old `operations` list), and drops every other service's switches on Agents.
- Its Service skill, `service-public-api`, teaches the API (Opsiforce Public API v1, docs at `/api/v1/docs` on the main host), how a pod's call differs from a person's, how to relay refusals, and how to talk to a created Project at the `baseUrl` Connect returns; the Skill & Agent Builder's `scripts/api.sh <METHOD> <path> [json]` is the shell form ([Skill & Agent Builder](../agent-system/skill-agent-builder.md)).

## Edge cases

- When a pod's Project has no recorded creator, `/api/v1` answers `401 unauthenticated`; when the creator left the Organization, `403 tenant-forbidden`.
- A creator's permissions are read at each call: a route needing a permission the creator lost answers `403 permission-denied` without `Opsiforce-Outcome`.
- `/api/v1/openapi.json` and `/api/v1/docs` are not decorated, so the Service host answers them *not supported*; read them on the main host.
- A Builder chat, a Test Project or the calling Project itself saved under *Other Projects* is ignored.
- A Project out of reach answers `404 project-not-found`, a picked one the creator can no longer see included; for an Agent Caller, on `/api/v1` and the runtime proxy alike, its `detail` names *Other Projects* and who can add to it.
- Deleting a picked Project while *Delete Projects* is off answers that setting's `403 not allowed` before the delete itself is refused.

## Code

- `external-services/public-api/` — the manifest, `service.ts` and the Service skill.
- `backend/src/external-services/built-ins/public-api-service.ts` — the service's routes, refusals and counters.
- `backend/src/external-services/built-ins/public-api-project-options.ts` — the Project form's pickers.
- `backend/src/external-services/configuration/public-api-settings.ts` — the settings and the Builder chat's starting values.
- `backend/src/project/calling-project-reach.ts` — containment: which Projects a pod reaches.
- `backend/src/public-api/auth/` — `@ServiceRoute` and the Caller-identity guard.

## Related

- [API Token](../public-api/api-token.md) — who an Agent Caller acts as and what it may touch.
- [Public API contract](../public-api/contract.md) — the `/api/v1` routes behind the service.
- [Created Projects and Agents](created-projects-and-agents.md) — which Agents, which Workspace and how many.
- [Skill & Agent Builder](../agent-system/skill-agent-builder.md) — the Agent that uses it most.
