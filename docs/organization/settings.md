---
kind: explanation
terms: [Settings]
---

# Settings

> How is the [Organization](../../GLOSSARY.md)'s configuration surface structured, and how does it decide which sections a member sees?

## How it works

- [Settings](../../GLOSSARY.md) is one page at `/settings` where a member configures the Organization chosen in the selector, with a left rail grouping sections by area: Access (Workspaces, Users), Configuration (Environments, Integrations, Model providers, Defaults, Limits) and Billing. Limits is the one section that ignores the selector, because it sets every Organization's values at once ([Limit](limit.md)); Model providers lets a platform admin manage the platform's own providers on its Built-in rows, which are the same whatever the selector says ([Model provider](model-provider.md)).
- Each section is its own route, so refresh and deep links keep the active tab, and each renders through a shared section header.
- Gating is centralised in the layout route: the rail shows only sections the member may manage, `/settings` and any forbidden tab redirect to the first permitted one, and a member with none is sent home while the avatar dropdown hides the entry.
- The backend gates the matching endpoints, so a hidden section is also a refused call ([Permissions](permissions.md)).
- The rail is one shared component driven by a per-section tab config (label, group, icon, permission); [Admin](admin.md) renders the same component with its own config, and the configure-versus-operate split decides which surface a page belongs to.
- [Store](../../GLOSSARY.md) is reached from the same avatar dropdown at `/store` and has three sections, Agents, Skills and External Services, as an underlined tab bar above the page, aligned with its content, rather than a rail. Each list has a search, filter chips and a Sort select (Name, by the label shown, or Newest, built-ins last), all kept in the URL (`?filter=&q=&sort=`), and pages its rows. Agents and Skills are open to every member because browsing the catalog is free; creating and editing, the Builder included, needs `can_manage_skills` or `can_manage_agents` ([Permissions](permissions.md)).
- The External Services tab shows only with `can_manage_platform_external_services` or `can_manage_tenant_external_services`, lists the built-ins and the Organization's own services with All, Created by me, Built-in, Custom, Not published, Needs setup (platform operators) and Disabled filters; All leaves disabled services out, as it does for Agents and Skills. A custom service's row shows Development plus every environment it is published to, the Default mark on the one callers reach, and "Not published yet" until its first Publish; a built-in's row says "Every environment". Each service page (`/store/external-services/<id>`) has Overview and API tabs for everyone who can open it, plus a Service configuration tab, a form generated from the service's Service form, and a Calls tab for the holder who may edit it (the platform permission for a built-in); an Organization admin without the platform permission sees only [Available](../../GLOSSARY.md) built-ins, read-only ([Configuration](../external-services/configuration.md), [Call log](../external-services/call-log.md)).
- With `can_manage_tenant_external_services`, **New External Service** registers a [Custom External Service](../../GLOSSARY.md) and opens its [External Service Builder](../../GLOSSARY.md) chat; the custom service's page adds the Default environment badge, the SDK badge, **Edit in Builder**, **Publish** (whose dialog also picks the environment callers reach), Disable, Enable and Delete ([External Service Builder](../external-services/external-service-builder.md)).
- Schedules is not a Settings section: it is operational, project-scoped runtime data and stays top-level ([Schedule](../projects/schedule.md)).

## Code

- `frontend/src/routes/settings/` — the layout route, gating and redirects.
- `frontend/src/constants/settings-tabs.tsx` — the single tab config behind the rail, the redirects and the dropdown check.
- `frontend/src/components/section-rail.tsx` — the rail shared with Admin.
- `frontend/src/components/store/store-nav.tsx` — the Store's tab bar.
- `frontend/src/routes/store/` — the Store layout route and its list pages.
- `frontend/src/components/external-service-form/` — the generic form renderer every Service form and Project form goes through.

## Related

- [Admin](admin.md) — the operational sibling on the same rail.
- [Permissions](permissions.md) — which members may author in the Store.
- [Environments](../projects/environments.md) — the Environment registry section.
- [Workspaces](workspaces.md) — the Workspaces section.
- [Model provider](model-provider.md) — the Model providers section.
- [Defaults](defaults.md) — the Defaults section.
- [Integrations](integrations.md) — the Integrations section.
