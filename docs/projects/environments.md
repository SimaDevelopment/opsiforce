---
kind: explanation
terms: [Environment, Environment Slug, Environment Color, Badge Label, ProjectEnvironment, App Auth, Auth mode, Active environment, Development, Production]
adrs: [0001, 0002, 0007, 0012, 0040]
---

# Environments

> How does a [Project](../../CONTEXT.md) run in several Environments, how is each one addressed and protected, and how does the workspace switch between them?

## How it works

### Two entities

- An [Environment](../../CONTEXT.md) is a tenant-wide publish target; a [ProjectEnvironment](../../CONTEXT.md) is one Project's running instance of it ([ADR-0001](../adr/0001-environment-vs-project-environment.md)).
- Every Project starts with a ProjectEnvironment bound to [Development](../../CONTEXT.md) whose id is the Project's own id ([ADR-0002](../adr/0002-development-environment-reuses-project-id.md)); each [Publish](publish.md) adds one with a fresh id, conventionally to [Production](../../CONTEXT.md) first.
- Projects reference the Environment registry by id, so renaming a custom Environment renames it for every Project at once; the two protected Environments cannot be renamed or deleted, and deleting a custom Environment is refused while any [Custom Agent](../../CONTEXT.md) holds a profile there or starts its new Projects from it, naming those Agents ([ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)).
- Each Environment carries an [Environment Color](../../CONTEXT.md) and a [Badge Label](../../CONTEXT.md), editable text of 2 to 5 letters or digits stored as `environments.short_name`; the sidebar renders one badge per ProjectEnvironment with the label over the colour as tint ([ADR-0040](../adr/0040-environment-badges-carry-a-short-name-over-the-identity-colour.md)). Both are edited from the Environment registry in [Settings](../organization/settings.md), protected Environments included, since neither appears in a URL.
- The Project owns identity, budget and idle timeouts, [Resources](../../CONTEXT.md), and the disabled flag, while the ProjectEnvironment owns files, pod, status, pod IP, [Auth mode](../../CONTEXT.md), [Schedules](../../CONTEXT.md), and service-gateway key. LLM keys are project-scoped: one Bifrost team and one key pair serve every environment ([ADR-0003](../adr/0003-one-bifrost-team-per-project-keys-per-env.md)).
- Actions follow the split: rename, duplicate, disable, enable, and delete act on the Project, where disable tears down every environment's pod, enable is refused when the Organization is at its Projects [Limit](../organization/limit.md), and delete removes every environment and the Bifrost team. Restart, Publish, App Auth, [Environment Variables](../../CONTEXT.md) ([Publish](publish.md)), and delete environment act on one ProjectEnvironment.

```
Tenant ── Environment registry: [ Development* , Production* , Staging ]   (*protected)
              ▲ binds to                ▲ binds to
Project ── ProjectEnvironment(Development)   ProjectEnvironment(Production)
 (shell)        = the working copy              = a published snapshot
```

### Public URLs

- An App's public host is `{environmentId}-{slug}` under the apps domain, where the slug is the Environment's [Environment Slug](../../CONTEXT.md) ([ADR-0012](../adr/0012-public-app-hostnames-carry-environment-slug.md)); the routing key is the environment id alone.
- The bare `{environmentId}` host also answers, and a request carrying a wrong slug redirects to the canonical host.

### App Auth

- [App Auth](../../CONTEXT.md) is enforced by an OIDC gate on the environment's own host, keyed by routing id ([ADR-0007](../adr/0007-per-environment-app-auth.md)).
- A newly published environment is seeded once, fail-closed, from Development's setting at first publish, then changed independently.

### In the workspace

- One Environments switcher next to the workspace tabs lists Development and every registry target, published or not; choosing one makes it the [Active environment](../../CONTEXT.md).
- The row menu holds App Auth, Environment Variables, Schedules, Restart, and delete; the project menu holds only project-level actions.
- A banner on any non-Development Active environment warns that edits there are overwritten by the next Publish.
- Gated by `can_manage_environments` and `can_delete_environment` ([Permissions](../organization/permissions.md)).

## Edge cases

- When the Badge Label is empty, the badge shows the Environment Slug's first letters, uppercased.
- When a custom Environment's slug is saved, it is immutable from then on; renames never change it, so published URLs outlive renames.

## Code

- `backend/src/environment/` — the tenant-wide Environment registry: names, slugs, colours, Badge Labels.
- `backend/src/project-environment/` — ProjectEnvironment rows, per-environment status, Auth mode and service-gateway key.
- `proxy/internal/server/server.go` — parses `{environmentId}-{slug}` hosts and redirects a wrong slug to the canonical host.
- `backend/src/project/project-auth.service.ts` — the App Auth gate configuration, keyed by routing id.
- `frontend/src/components/project/environments/` — the Environments switcher, row menus and the non-Development banner.
- `frontend/src/components/tenant-environments/` — the registry editor for colour and Badge Label.

## Related

- [Publish](publish.md) — moving the App from Development into an environment, and Environment Variables.
- [App](app.md) — per-environment App Details.
- [Duplication](duplication.md) — copies a whole Project through the same git path.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — pod statuses, suspension, Restart.
- [Settings](../organization/settings.md) — the Environment registry section.
