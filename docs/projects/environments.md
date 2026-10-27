---
kind: explanation
terms: [Environment, Environment Slug, Environment Color, Badge Label, ProjectEnvironment, App Auth, Auth mode, Active environment, Development, Production]
adrs: [0001, 0002, 0007, 0040]
---

# Environments

> How does a [Project](../../GLOSSARY.md) run in several Environments, how is each one named and protected, and how does the workspace switch between them?

## How it works

### Two entities

- An [Environment](../../GLOSSARY.md) is a tenant-wide publish target; a [ProjectEnvironment](../../GLOSSARY.md) is one Project's running instance of it ([ADR-0001](../adr/0001-environment-vs-project-environment.md)).
- Every Project starts with a ProjectEnvironment bound to [Development](../../GLOSSARY.md) whose id is the Project's own id ([ADR-0002](../adr/0002-development-environment-reuses-project-id.md)); each [Publish](publish.md) adds one with a fresh id, conventionally to [Production](../../GLOSSARY.md) first.
- Projects reference the Environment registry by id, so renaming a custom Environment renames it for every Project at once; the two protected Environments cannot be renamed or deleted, and deleting a custom Environment is refused while any [Custom Agent](../../GLOSSARY.md) holds a profile there or starts its new Projects from it, naming those Agents ([ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)).
- Each Environment carries an [Environment Color](../../GLOSSARY.md) and a [Badge Label](../../GLOSSARY.md), editable text of 2 to 5 letters or digits stored as `environments.short_name`; the sidebar renders one badge per ProjectEnvironment with the label over the colour as tint ([ADR-0040](../adr/0040-environment-badges-carry-a-short-name-over-the-identity-colour.md)). Both are edited from the Environment registry in [Settings](../organization/settings.md), protected Environments included, since neither appears in a URL.
- The Project owns identity, budget and idle timeouts, [Resources](../../GLOSSARY.md), and the disabled flag, while the ProjectEnvironment owns files, pod, status, pod IP, [Auth mode](../../GLOSSARY.md), [Schedules](../../GLOSSARY.md), and service-gateway key. LLM keys are project-scoped: one Bifrost team and one key pair serve every environment ([ADR-0003](../adr/0003-one-bifrost-team-per-project-keys-per-env.md)).
- Actions follow the split: rename, duplicate, disable, enable, and delete act on the Project, where disable tears down every environment's pod, enable is refused when the Organization is at its Projects [Limit](../organization/limit.md), and delete removes every environment and the Bifrost team. Restart, Publish, App Auth, [Environment Variables](../../GLOSSARY.md) ([Publish](publish.md)), Rotate Gateway Key, and delete environment act on one ProjectEnvironment. Rotate Gateway Key (`POST /api/projects/<id>/environments/<environmentId>/gateway-key/rotate`, anyone who can open the Project) mints a new service-gateway key, revokes the old one at once, has the Gate forget it and restarts a pod that is not asleep. An [External Service Builder](../../GLOSSARY.md) Project's delete and delete environment answer `409 manage-from-service-page`, since its [Custom External Service](../../GLOSSARY.md) is deleted only from the service's page, and its disable and enable do what the service page's do ([External Service Builder](../external-services/external-service-builder.md)).

```
Tenant ── Environment registry: [ Development* , Production* , Staging ]   (*protected)
              ▲ binds to                ▲ binds to
Project ── ProjectEnvironment(Development)   ProjectEnvironment(Production)
 (shell)        = the working copy              = a published snapshot
```

### Addressing

- Each Environment carries an [Environment Slug](../../GLOSSARY.md): `dev` and `prod` for the protected ones; for a custom one it is prefilled from the name and editable once before saving, unique within the tenant, never ending with 12 or more characters from 0-9 and a-f (how a Public URL ends its App Short ID), then immutable, so renames never move an address. It names the environment in every App's [Public URL](../../GLOSSARY.md) ([Public URL](public-url.md)), where the [App Short ID](../../GLOSSARY.md), not the slug, picks the ProjectEnvironment ([ADR-0012](../adr/0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)).

### App Auth

- [App Auth](../../GLOSSARY.md) is enforced by an OIDC gate keyed by routing id ([ADR-0007](../adr/0007-per-environment-app-auth.md)) on every address that reaches the App: any first label ending in `-{App Short ID}` under the apps domain, and the environment id alone or followed by a dash and any suffix, which covers both legacy hosts. The backend serves or redirects only hosts these patterns match, so a new or edited App Slug never opens an unprotected address, and the environment-id rule outranks the App Short ID pattern, so a legacy host whose Environment Slug equals another App's Short ID still reaches its own App ([ADR-0012](../adr/0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)).
- The catch-all apps route, which has no gate, marks every request it passes, and the app proxy answers a marked request for an environment whose Auth mode is not public with a 403, without contacting the pod or redirecting, and logs a warning naming the environment. A missing or stale gate route therefore makes a protected App unreachable on that host, never unprotected ([ADR-0012](../adr/0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)).
- At backend start, and once more five minutes later, every environment whose App Auth is not public has its gate route's rules rewritten when they are out of date; the OIDC Middleware, which holds the whole OIDC config including token forwarding, is never touched, and replicas running it at once converge on the same rules. An environment with no route gets none.
- The App Auth dialog lists `/oidc/callback` on every host that serves the App: the Public URL's host when the App has an App Slug, and the two legacy hosts.
- A newly published environment is seeded once, fail-closed, from Development's setting at first publish, and a [Duplicate](../../GLOSSARY.md)'s Development from its source's ([Duplication](duplication.md)); each is changed independently after that. Deleting an environment removes its gate, and deleting a Project removes the gate of every one of its environments, as does discarding a Project a failed create, Duplicate or Import left half-made.
- App code receives App Auth's own `TraefikOidcAuth…` session cookies, scoped to the host the visitor signed in on, but never the platform's: the app proxy deletes every cookie named `_opsiforce_…`, a prefix reserved for the platform on App hosts ([Request Flows](../runtime/request-flows.md#per-surface)).

### In the workspace

- One Environments switcher next to the workspace tabs lists Development and every registry target, published or not; choosing one makes it the [Active environment](../../GLOSSARY.md).
- The row menu holds App Auth, Environment Variables, Schedules, Restart, and delete; the project menu holds only project-level actions.
- A banner on any non-Development Active environment warns that edits there are overwritten by the next Publish.
- Gated by `can_manage_environments` and `can_delete_environment` ([Permissions](../organization/permissions.md)).

## Edge cases

- When the Badge Label is empty, the badge shows the Environment Slug's first letters, uppercased.

## Code

- `backend/src/environment/` — the tenant-wide Environment registry: names, slugs, colours, Badge Labels.
- `backend/src/project-environment/` — ProjectEnvironment rows, per-environment status, Auth mode and service-gateway key.
- `backend/src/project/project-auth.service.ts` — the App Auth gate configuration, keyed by routing id.
- `backend/src/project/app-auth-route.ts` — the gate route's rules over every App address and their priorities.
- `frontend/src/components/project/environments/` — the Environments switcher, row menus and the non-Development banner.
- `frontend/src/components/tenant-environments/` — the registry editor for colour and Badge Label.

## Related

- [Public URL](public-url.md) — the address each App answers on, the App Slug and Edit URL.
- [Publish](publish.md) — moving the App from Development into an environment, and Environment Variables.
- [App](app.md) — per-environment App Details.
- [Duplication](duplication.md) — copies a whole Project through the same git path.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — pod statuses, suspension, Restart.
- [Settings](../organization/settings.md) — the Environment registry section.
