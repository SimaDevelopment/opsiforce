---
kind: explanation
terms: [Admin]
adrs: [0014]
---

# Admin

> Where does a member observe and operate running state, and how does a new operational view get added?

## How it works

- [Admin](../../GLOSSARY.md) is reached from the avatar dropdown and built on the same left-rail layout as [Settings](settings.md): one page per area, each independently gated ([ADR-0014](../adr/0014-admin-section-and-operational-view-module.md)).
- A page that shows or acts on what is running now belongs in Admin; a page that changes stored configuration belongs in Settings; a page that browses or authors the Organization's catalog of Agents, Skills and External Services belongs in [Store](../../GLOSSARY.md), the third section on the same rail.
- Its pages are [Pods](../runtime/pods.md), the first page and the [Organization](../../GLOSSARY.md)'s running environment pods; and [Storage](../runtime/storage.md), platform-wide disk usage gated by a [Platform-scope permission](../../GLOSSARY.md). An External Service's Calls and Usage live on its service page ([Call log](../external-services/call-log.md)).
- The layout route redirects to the first permitted page, and the dropdown entry appears only when the member can see at least one Admin page.
- A new operational view is one entry in the Admin tab config and one controller in the backend `admin` module; no navigational plumbing changes.

## Code

- `frontend/src/routes/admin/` — the layout route and the pages.
- `frontend/src/constants/admin-tabs.tsx` — the Admin tab config.
- `backend/src/admin/` — the operational endpoints.

## Related

- [Settings](settings.md) — the configuration sibling.
- [Pods](../runtime/pods.md) — the first Admin page.
- [Storage](../runtime/storage.md) — the platform-wide page.
- [Permissions](permissions.md) — how each page is gated.
