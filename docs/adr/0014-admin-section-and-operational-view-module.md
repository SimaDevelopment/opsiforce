# Operational views live in an "Admin" section, in their own aggregator module — not folded into `pod`

**Operational views live in Admin, a sibling of Settings reached from the avatar dropdown and built on the same left rail.** The dividing line is *configure vs operate*: a page that changes stored configuration belongs to Settings; a page that shows or acts on what is running now belongs to Admin. Admin's pages are Pods, Usage, External services and Storage, each gated by its own permission (`can_view_pods`, `can_view_external_services_usage`, `can_manage_external_services`, `can_view_platform_storage`). Schedules stays a standalone dropdown item.

## Why the rail is shared, not duplicated

Settings and Admin need identical behaviour: a tab config, a rail, and a layout route that redirects to the first permitted tab. Both render one `SectionRail` driven by their own tab config. Two rails would drift; one keeps the sections visually and behaviourally identical for free.

## Why the Pods view has its own backend module instead of living in `pod`

The Pods view is an **aggregator**: it joins the Kubernetes pod informer (owned by `PodModule`) with the Redis keep-alive (owned by `TimeoutModule`), and `TimeoutModule` already depends on `PodModule`. Folding the view into `PodModule` would make `PodModule` depend on `TimeoutModule` in return — a circular module dependency resolvable only with `forwardRef` — and would mix read-only view code into the pod lifecycle module. So the view has its own module, named `admin` after the product section and kept visibly apart from `pod`. The HTTP route is `GET /api/pods`, a resource name independent of the module that serves it. Admin pages with no such cycle are served by their own domain's module (`storage`, `external-services`).

## Consequences

- The avatar dropdown shows **Admin** when the member has any permitted Admin page.
- Adding an operational view is a new entry in the Admin tab config on the frontend; on the backend it goes in its domain's module, or in `admin` when it aggregates modules that would otherwise form a cycle.
- The configure-vs-operate split is recorded in [CONTEXT.md](../../CONTEXT.md) under **Admin** and **Settings**; it is the test for where any future page belongs.
- This is the same authority model as [ADR-0013](0013-pods-view-reads-live-keepalive-from-redis.md): Admin observes running state; it does not become a new source of truth.
