---
kind: explanation
terms: [Workspace, Personal Workspace, Public Workspace]
adrs: [0021, 0025, 0029]
---

# Workspaces

> How are [Projects](../../CONTEXT.md) grouped and made visible inside an [Organization](../../CONTEXT.md), and who may move them where?

## How it works

### Three groupings

- A shared [Workspace](../../CONTEXT.md) is created by holders of `can_manage_workspaces`, who are added as members; it has an explicit member list and only members see it.
- A [Personal Workspace](../../CONTEXT.md) is created for each member on first authentication, one per user and Organization while the per-tenant toggle is on; it is owned by the user, invisible to everyone else, and cannot be renamed, deleted or given members.
- The [Public Workspace](../../CONTEXT.md) holds Projects with no Workspace and is visible to every member of the Organization.
- A [Folder](folder.md) groups Projects inside a shared or Personal Workspace, never in Public.

### Visibility is membership

- The sidebar shows the Workspaces a member belongs to, plus their Personal Workspace and Public; permissions never widen it, and a non-member gets 404 on a direct link.
- The one exception is the management surface at `/settings/workspaces`, where holders of `can_manage_workspaces` see every shared Workspace to rename, delete or join; Personal Workspaces are never listed there.
- The sidebar orders Projects by the time of the last [Prompt](../../CONTEXT.md) a user sent, not by keep-alive activity ([ADR-0021](../adr/0021-sidebar-orders-by-last-prompt.md)).
- Project rows are draggable but never sortable: a drop target is always a Workspace or Folder zone, since Project order is never persisted ([ADR-0029](../adr/0029-project-rows-are-draggables-not-sortables.md)).

### Moving Projects

- `can_manage_workspaces` creates, renames and deletes shared Workspaces, manages members, creates Projects in Public and moves Projects into Public; `can_move_projects_between_workspaces` moves a Project between two shared Workspaces the mover belongs to or pulls a Public Project into one.
- Moving into or out of one's own Personal Workspace needs no permission; moving into another user's Personal Workspace is impossible because it does not exist from the mover's point of view.
- Making an existing Public or shared-Workspace Project personal is refused server-side, and the sidebar and the Move to menu mirror the rule so the attempt fails before the round trip.

### Per-tenant toggle

- Personal Workspaces are a per-tenant setting, on by default, flipped from `/settings/workspaces` by holders of `can_manage_workspaces` ([ADR-0025](../adr/0025-private-workspaces-are-a-per-tenant-toggle.md)).
- When it is off, no Personal Workspace is provisioned, existing ones are hidden: listings, direct links, their Projects, and every write into them answer 404 while nothing is mutated, and Public becomes the default destination for new Projects, with the create permission requirement dropped for that tenant.

## Edge cases

- When a permission-less move is dropped, the row stays draggable but the server rejects the drop with a surfaced error.
- When a shared Workspace is deleted, its members are cleared and its Projects land in Public; when a user is deleted, their Personal Workspace cascades away and its Projects land in Public.
- When the toggle is switched back on, hidden Personal Workspaces reappear unchanged, and users who first signed in while it was off get theirs on their next request.
- A Personal Workspace cannot be deleted through the API; only the owner-user cascade removes it.

## Code

- `backend/src/workspace/` — Workspace CRUD, membership, move rules and the toggle.
- `backend/src/project/` — visibility enforcement on Project reads and moves.
- `workspaces` in `backend/db/schema.ts` — Workspaces and their members.
- `frontend/src/pages/workspaces.tsx` — the management surface and the toggle.
- `frontend/src/lib/sidebar-dnd.ts` — the sidebar drop zones.

## Related

- [Folder](folder.md) — the single-level grouping inside a Workspace.
- [Permissions](permissions.md) — how the two permission strings flow from the identity provider.
- [Settings](settings.md) — the management surface's section.
- [API Token](../public-api/api-token.md) — where a service account's Projects land.
