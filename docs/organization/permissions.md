---
kind: explanation
terms: [Platform-scope permission]
adrs: [0027]
---

# Permissions

> How do permissions flow from the identity provider to the UI and the backend, and what does the backend enforce?

## How it works

### The flow

- Opsiforce has no roles of its own, only flat permission strings (`can_*`) issued through Keycloak groups: a group bundles realm roles such as `role:opsiforce_can_publish_project`, oauth2-proxy forwards them in `x-forwarded-groups`, and the backend's permissions endpoint keeps the `role:opsiforce_*` entries, strips the prefix and returns the list the frontend gates on.
- The canonical list of strings is the code: the backend's permission constants and the frontend's permissions constants.
- A standalone install without Keycloak maps its identity provider's groups through `SSO_GROUP_MAP`, a JSON object from group name to `{permissions, tenants}`; a group granting Model providers lists `can_manage_tenant_model_providers` there like any other string.
- In static auth mode nginx injects a fixed identity carrying every `can_*` role into the same header, and everything downstream is identical ([Local orchestration](../operations/local-orchestration.md)).

```
Keycloak realm roles
   │  (group bundles roles like role:opsiforce_can_publish_project)
   ▼
oauth2-proxy  ──  x-forwarded-groups  ──▶  Backend  ──▶  GET /api/permissions → ["can_publish_project", …]
                                              │                    ▼
                                    @RequirePermission guard   frontend hasPermission()
```

### Gating and enforcement

- The permissions endpoint powers UI gating only; enforcement is a route protected by `@RequirePermission`, at class or method level, checked by the global permission guard against the groups header.
- A route with no `@RequirePermission` is open to any authenticated member, so gating a feature means gating its endpoint too.
- Feature pages own their own permission semantics, such as how `can_manage_workspaces` widens visibility only on the management surface ([Workspaces](workspaces.md)).
- `can_manage_tenant_model_providers` gates Settings, Model providers and every route behind it: seeing the Organization's [Model providers](../../CONTEXT.md), switching and weighting them; the one read it does not gate is the list of reachable Base formats, which every member gets for the model pickers. It is in the `opsiforce_admin` bundle and also granted alone by the `opsiforce_manage_tenant_model_providers` group, because it holds where every request goes, a different trust from `can_manage_tenant_budget` ([Model provider](model-provider.md)).
- `can_manage_platform_model_providers` gates the ⋮ menus and URLs of Built-in rows on the same page, the Global checkbox of Add model provider, and every `/api/platform-model-providers` route: replacing the key of the platform's `openai` and `anthropic`, signing in its Linked accounts, and adding, editing and deleting `opsiforce-*` providers, which reach every Organization switched off. It is a Platform-scope permission granted only by its own hand-assigned `opsiforce_manage_platform_model_providers` group, never by `opsiforce_admin`, because it controls model access for every Organization; alone, it shows the format cards with only the platform's providers and no Organization's own rows ([Opsiforce model provider](opsiforce-model-provider.md)).
- The Store adds `can_manage_skills` and `can_manage_agents` to the canonical list. `can_manage_skills` gates Skill authoring: `SkillsController` carries a class-level `@RequirePermission` and lifts it per route with `@RelaxPermission()`, so listing Skills, reading every file of a Version and exporting one need no permission at all. `BuilderController` opens on either Store permission through `@RequireAnyPermission`, and each chat then needs the one matching its subject: `can_manage_skills` for a Skill's, `can_manage_agents` for an Agent's. Import (Agent) needs both, since it may create Custom Skills, and the chunked import upload routes it shares with Project Import accept `can_import_project` or `can_manage_agents` through `@RequireAnyPermission`.

### Platform scope

- Almost every route is [Organization](../../CONTEXT.md)-scoped: the tenant guard requires membership in the requested Organization and stamps a tenant context that services filter by.
- A route marked `@PlatformScope()` still demands the groups header but resolves no Organization and stamps no context, so its `@RequirePermission` is the only gate; the permissions and Organization-list discovery endpoints are platform-scope for the same reason ([ADR-0027](../adr/0027-platform-scope-routes-opt-out-of-tenant-resolution.md)).
- A [Platform-scope permission](../../CONTEXT.md) carries `platform_` in its name, gets its own standalone Keycloak group and stays out of the default admin bundle; it is granted alongside an ordinary Organization membership, since the app shell assumes every account belongs to one.

## Code

- `backend/src/permission/` — the constants, the guard and the decorators.
- `frontend/src/api/permissions.ts` — the permissions query and `hasPermission`.
- `frontend/src/constants/permissions.ts` — the frontend's copy of the strings.

## Related

- [Settings](settings.md) — how section visibility is centralised.
- [Admin](admin.md) — the operational surface and its platform-scope pages.
- [Workspaces](workspaces.md) — the two workspace permissions and their carry rules.
- [API Token](../public-api/api-token.md) — the same permissions on the public API.
- [Add a permission](../operations/add-a-permission.md) — the steps.
