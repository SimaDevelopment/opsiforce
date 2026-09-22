---
kind: explanation
terms: [Settings]
---

# Settings

> How is the [Organization](../../CONTEXT.md)'s configuration surface structured, and how does it decide which sections a member sees?

## How it works

- [Settings](../../CONTEXT.md) is one page at `/settings` where a member configures the Organization chosen in the selector, with a left rail grouping sections by area: Access (Workspaces, Users), Configuration (Environments, Integrations, Defaults) and Billing.
- Each section is its own route, so refresh and deep links keep the active tab, and each renders through a shared section header.
- Gating is centralised in the layout route: the rail shows only sections the member may manage, `/settings` and any forbidden tab redirect to the first permitted one, and a member with none is sent home while the avatar dropdown hides the entry.
- The backend gates the matching endpoints, so a hidden section is also a refused call ([Permissions](permissions.md)).
- The rail is one shared component driven by a per-section tab config (label, group, icon, permission); [Admin](admin.md) and [Store](../../CONTEXT.md) render the same component with their own configs, and the configure-versus-operate split decides which surface a page belongs to.
- Store is the third section on that rail, reached from the same avatar dropdown at `/store`: its Agents and Skills tabs are open to every member because browsing the catalog is free, and only the Skill & Agent Builder tab needs `can_manage_skills` or `can_manage_agents` ([Permissions](permissions.md)).
- Schedules is not a Settings section: it is operational, project-scoped runtime data and stays top-level ([Schedule](../projects/schedule.md)).

## Code

- `frontend/src/routes/settings/` — the layout route, gating and redirects.
- `frontend/src/constants/settings-tabs.tsx` — the single tab config behind the rail, the redirects and the dropdown check.
- `frontend/src/components/section-rail.tsx` — the rail shared with Admin and Store.
- `frontend/src/constants/store-tabs.ts` — the Store tab config.
- `frontend/src/routes/store/` — the Store layout route and its list pages.

## Related

- [Admin](admin.md) — the operational sibling on the same rail.
- [Permissions](permissions.md) — which members reach Store and its Builder tab.
- [Environments](../projects/environments.md) — the Environment registry section.
- [Workspaces](workspaces.md) — the Workspaces section.
- [Defaults](defaults.md) — the Defaults section.
- [Integrations](integrations.md) — the Integrations section.
