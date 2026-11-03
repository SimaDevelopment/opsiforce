# Operational views live in an "Admin" section, in their own aggregator module — not folded into `pod`

**Operational views live in Admin, a sibling of Settings reached from the avatar dropdown; while either section is open, the sidebar lists that section's pages in place of the project tree.** The dividing line is *configure vs operate*: a page that changes stored configuration belongs to Settings; a page that shows or acts on what is running now belongs to Admin. Admin's pages are Pods and Storage, each gated by its own permission (`can_view_pods`, `can_view_platform_storage`). Schedules stays a standalone sidebar row.

## Why the section navigation is shared, not duplicated

Settings and Admin need identical behaviour: a tab config, a navigation list, and a layout route that redirects to the first permitted tab. Both hand their own tab config to one `SidebarSectionNav`, which the sidebar renders in place of the project tree. Two lists would drift; one keeps the sections visually and behaviourally identical for free.

## Why the navigation lives in the sidebar rather than in a second rail

A rail beside the sidebar put two columns of navigation in front of one page of content. The sidebar is the one place the product lists where a member can go, so a section swaps the sidebar's contents and offers the way back, instead of opening a column of its own.

## Why the Pods view has its own backend module instead of living in `pod`

The Pods view is an **aggregator**: it joins the Kubernetes pod informer (owned by `PodModule`) with the Redis keep-alive (owned by `TimeoutModule`), and `TimeoutModule` already depends on `PodModule`. Folding the view into `PodModule` would make `PodModule` depend on `TimeoutModule` in return — a circular module dependency resolvable only with `forwardRef` — and would mix read-only view code into the pod lifecycle module. So the view has its own module, named `admin` after the product section and kept visibly apart from `pod`. The HTTP route is `GET /api/pods`, a resource name independent of the module that serves it. Admin pages with no such cycle are served by their own domain's module (`storage`, `external-services`).

## Consequences

- The avatar dropdown shows **Admin** when the member has any permitted Admin page.
- Adding an operational view is a new entry in the Admin tab config on the frontend; on the backend it goes in its domain's module, or in `admin` when it aggregates modules that would otherwise form a cycle.
- The configure-vs-operate split is recorded in [GLOSSARY.md](../../GLOSSARY.md) under **Admin** and **Settings**; it is the test for where any future page belongs.
- This is the same authority model as [ADR-0013](0013-pods-view-reads-live-keepalive-from-redis.md): Admin observes running state; it does not become a new source of truth.
