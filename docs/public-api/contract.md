---
kind: explanation
terms: [Error]
adrs: [0035]
---

# Public API contract

> What does `/api/v1` expose, how does it fail, and how does the contract evolve?

## How it works

### Resources

- `/me` is who the token is and which [Organizations](../../CONTEXT.md) it may act in; `/agents` lists the [Agents](../../CONTEXT.md) a Project can be built on, and creates, describes, profiles, saves the Development [Template](../../CONTEXT.md) of and sets the [Agent Skills](../../CONTEXT.md) of a [Custom Agent](../../CONTEXT.md); `/skills` reads, validates, creates, renames, duplicates and publishes a [Skill Version](../../CONTEXT.md) of a [Skill](../../CONTEXT.md); `/projects` lists, reads, creates, restarts and deletes the [Projects](../../CONTEXT.md) the caller can see, and updates and resets a [Test Project](../../CONTEXT.md), each with every [ProjectEnvironment](../../CONTEXT.md) and its status ([API Token](api-token.md)).
- The Skill and Agent resources are bounded by verb: Delete, Disable, Enable, Import, widening [Visibility](../../CONTEXT.md), Publish (Agent), Duplicate (Agent) and Agent settings have no route on `/api/v1` ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)); `PATCH /agents/{id}` carries only `displayName` and `description` and `PATCH /skills/{id}` only `displayName`, so an Agent's slug ([ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)) and a Skill's `name` ([ADR-0051](../adr/0051-skills-are-stored-as-immutable-per-file-versions-and-a-built-in-agents-skills-live-on-a-development-profile.md)) never change.
- `PUT /agents/{id}/template` takes no body: it mirrors the `template/` folder of the calling Builder chat's workspace into the Agent's Development Template and answers the new `hash` (null when the folder was missing or empty), the saved `files` with size and executable bit, the `skipped` paths and the `warnings`, each with a reason. Only the Agent Caller whose Project is that Agent's Builder chat may call it; a person, another chat and a Test Project get `forbidden`. There is no read-back and no delete route: `GET /agents/{id}` carries `template: { hash, damaged } | null` on every Environment entry ([Custom Agents](../agent-system/custom-agents.md)).
- Authoring gates on `can_manage_skills` and `can_manage_agents`, weighed after the visibility read, so a Skill or Agent the caller may not see is a plain not-found. Reading them needs neither permission.
- Creation is asynchronous: a new Project answers immediately with its Development environment still starting; deleting needs `can_delete_project`; the Project and Agent lists paginate by cursor; anything the caller may not see is a plain not-found.
- A Project carries its provenance: `createdBy` is the platform user that created it, `createdByProjectId` the Project whose Agent created it when a pod did, and `importedAgent` the Agent name it was imported under; each is null when it does not apply, and older Projects have no `createdBy`. `kind` marks a Project the platform keeps for itself: it is absent from `/projects`, and it answers not-found by id to everyone but its creator and those who can see the Skill or Agent its Builder chat authors ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)). An Agent Caller running a Builder chat is the one caller that may send `kind`, as `test`, when it creates one, and it gets one per chat: a second create answers 409 `test-project-exists` carrying the existing `testProjectId` and deletes nothing, and `GET /me` names the chat's Test Project as `builderTestProject: { id } | null`, non-null only for a Builder chat's gateway key whose chat has one.
- `POST /projects/{id}/test/update` and `POST /projects/{id}/test/reset` refresh a Test Project in place and answer 204. They are open only to the gateway caller whose Project created the Test Project (`createdByProjectId`); a person, another chat and the Test Project's own key are refused (403 for a caller that can see it, 404 for one that cannot). Update overlays the Agent's Development Template onto the workspace, overwriting and adding without deleting, commits the files it wrote as "Template update", and leaves the pod, the session and the Bifrost spend alone. Reset stops the pod, wipes the workspace, lays the Template, prompt and Skills from Development as a create does, unpins the primary Session, resets the Project's Bifrost spend and starts the pod; the Project id stays the same, and a disabled Project answers 423 ([Test Project](../agent-system/test-project.md)).

### Errors

- Every failure on `/api/v1` is an [Error](../../CONTEXT.md): a stable `type` URN, a fixed title for that kind, a `detail` written for the caller, and the request id as `instance`, echoed in `X-Request-Id`.
- Six extension members let a caller act on a failure: a rejected request and an unknown reference list their `errors` by pointer and location, a refused Skill tree adds the rule, file and line of each one and carries its non-blocking warnings as `lints`, an ambiguous Organization lists the `tenants` to choose from, a denial names the `permission` that was missing — except when a route is simply closed to the caller's kind of credential, which names none ([API Token](api-token.md)) — and `test-project-exists` names the chat's `testProjectId`.
- The Skill and Agent refusals carry types of their own, so a program branches on `type` alone: `name-unavailable`, `validation-failed`, `visibility-incoherent`, `skill-in-use`, `duplicate-skill-name`, `model-unknown`, `not-publishable`, `template-refused` (one `errors` item per refused path, naming its `file` and `rule`), `template-changed` and `test-project-exists`; a Project create refused by an Organization's [Limit](../../CONTEXT.md) is `limit-reached`.
- Types are URNs, not URLs, so no self-hosted deployment has to serve a page per type; a 4xx raised inside a reused domain service keeps its message as `detail`, while anything 5xx gets a generic detail.
- Failures on `/api/proxy/{environmentId}` are not platform Errors: they are opencode's own, or the edge's and the proxy's ([Connection](connection.md)).

### Evolution

- The major version is in the path; within v1 changes are additive only (new routes, optional fields, query parameters, event kinds, enum values), a field is never removed or retyped, a deprecated field is marked and keeps working, and breaking changes ship as `/api/v2` alongside ([ADR-0035](../adr/0035-public-api-module-with-uri-versioning-and-additive-compat.md)).
- The policy covers platform-owned resources only; the opencode surface behind `baseUrl` is the protocol of the deployed build and moves with the agent image.

### Where it is built

- The API is a separate `public-api` module tree with one sub-module per resource and shared auth, errors and validation, reusing the domain services underneath; one zod schema per DTO validates the request, serializes the response and produces the OpenAPI 3.1 document served at `/api/v1/openapi.json` and rendered by Scalar at `/api/v1/docs`, neither needing a token.
- The schemas plug into NestJS 12's native Standard Schema support and are strict on both sides.
- The API brings its own Fastify adapter, which keeps the original Fastify error as the `cause` so a malformed body reaches the filter as a validation failure, and replaces the JSON body parser with one that lets an empty body through on `/api/v1` paths so a bodiless `connect` works from any client.
- There is no committed spec snapshot; the running server is the source of truth.

## Edge cases

- When a request carries an unrecognised field, the answer is a validation Error.
- When a response fails the server's own schema, the request fails with a 5xx Error.
- When an empty JSON body arrives outside `/api/v1`, it is still the error it always was.

## Code

- `backend/src/public-api/` — the module tree, one sub-module per resource.
- `backend/src/public-api/errors/` — the Error shape, the exception filter and the mapper that turns the domain services' coded refusals into the Skill and Agent Errors.
- `backend/src/public-api/public-api-fastify.adapter.ts` — the adapter with the two concessions.
- `backend/src/public-api/public-api.docs.ts` — the OpenAPI document and the Scalar page.

## Related

- [API Token](api-token.md) — who may call and how.
- [Connection](connection.md) — the route that hands a program to opencode.
- [Permissions](../organization/permissions.md) — the permissions the API gates on.
- [Testing](../backend/testing.md) — where the API's tests live.
