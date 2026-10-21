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
- `can_manage_tenant_model_providers` gates Settings, Model providers and every route behind it: seeing the Organization's [Model providers](../../GLOSSARY.md), switching and weighting them; the one read it does not gate is the list of reachable models, which every member gets for the model pickers. It is in the `opsiforce_admin` bundle and also granted alone by the `opsiforce_manage_tenant_model_providers` group, because it holds where every request goes, a different trust from `can_manage_tenant_budget` ([Model provider](model-provider.md)).
- `can_manage_platform_model_providers` gates the ⋮ menus and URLs of Built-in rows on the same page, the Global checkbox of Add model provider, and every `/api/platform-model-providers` route: replacing the key of the platform's `openai` and `anthropic`, signing in its Linked accounts, and adding, editing and deleting `opsiforce-*` providers, which reach every Organization switched off. It is a Platform-scope permission granted only by its own hand-assigned `opsiforce_manage_platform_model_providers` group, never by `opsiforce_admin`, because it controls model access for every Organization; alone, it shows the format cards with only the platform's providers and no Organization's own rows ([Opsiforce model provider](opsiforce-model-provider.md)).
- The Store adds `can_manage_skills` and `can_manage_agents` to the canonical list. `can_manage_skills` gates Skill authoring: `SkillsController` carries a class-level `@RequirePermission` and lifts it per route with `@RelaxPermission()`, so listing Skills, reading every file of a Version and exporting one need no permission at all. `BuilderController` opens on either Store permission or `can_manage_tenant_external_services` through `@RequireAnyPermission`, and each chat then needs the one matching its subject: `can_manage_skills` for a Skill's, `can_manage_agents` for an Agent's, `can_manage_tenant_external_services` for an External Service's. Import (Agent) needs both, since it may create Custom Skills, and the chunked import upload routes it shares with Project Import and Import (External Service) accept `can_import_project`, `can_manage_agents` or `can_manage_tenant_external_services` through `@RequireAnyPermission`.

### External Services

- `can_manage_platform_external_services` edits the [Service configuration](../../GLOSSARY.md) of every [Built-in External Service](../../GLOSSARY.md), such as WhatsApp's numbers, and guards the `external-services/platform/services` routes that list the built-ins, open one, save its Service configuration and run its form calls. It is a Platform-scope permission granted only by its own hand-assigned `opsiforce_manage_platform_external_services` group, renamed in place from `can_manage_external_services` so its members kept it.
- `can_manage_tenant_external_services` covers the Organization's own [Custom External Services](../../GLOSSARY.md): building, publishing, configuring, disabling and deleting them, and reading the [Call log](../../GLOSSARY.md) and [Usage (External Service)](../../GLOSSARY.md) of every service, built-ins included, for this Organization (`external-services/services/<id>/call-log` and `…/usage`). It also lists the [Available](../../GLOSSARY.md) Built-in External Services read-only through the `external-services/services` routes, which the platform permission opens too. It alone opens and chats in an Organization's External Service Builder chats and their Test Projects, in every environment and whoever created them: they share a pod with the service's secrets, so neither the creator nor `can_manage_skills`/`can_manage_agents` reaches them without it. Its holders type those services' secrets, so it has its own group besides the `opsiforce_admin` bundle.
- `can_configure_project_external_services` edits a ProjectEnvironment's [Project configuration](../../GLOSSARY.md), whose first save enables the service there and brings its Service skill, and its [Service skill](../../GLOSSARY.md) switches, which every member who can open the Project reads; `can_manage_project_skills` [switches off](../../GLOSSARY.md) Store and package Skills per ProjectEnvironment. Both are in the `opsiforce_admin` bundle and each also has its own group.
- A service's Calls and monthly [Usage](../../GLOSSARY.md) show on its service page to `can_manage_tenant_external_services`. A ProjectEnvironment's Calls to one service, shown in its Project configuration dialog, need no permission beyond opening the Project.

### Platform scope

- Almost every route is [Organization](../../GLOSSARY.md)-scoped: the tenant guard requires membership in the requested Organization and stamps a tenant context that services filter by.
- A route marked `@PlatformScope()` still demands the groups header but resolves no Organization and stamps no context, so its `@RequirePermission` is the only gate; the permissions and Organization-list discovery endpoints are platform-scope for the same reason ([ADR-0027](../adr/0027-platform-scope-routes-opt-out-of-tenant-resolution.md)).
- A [Platform-scope permission](../../GLOSSARY.md) carries `platform_` in its name, gets its own standalone Keycloak group and stays out of the default admin bundle; it is granted alongside an ordinary Organization membership, since the app shell assumes every account belongs to one.

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
