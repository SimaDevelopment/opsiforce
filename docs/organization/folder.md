---
kind: explanation
terms: [Folder]
---

# Folder

> How are [Projects](../../CONTEXT.md) grouped inside a Workspace by a single-level label, and what does that label change about who sees them?

## How it works

- A [Folder](../../CONTEXT.md) is a named, single-level grouping of Projects inside one [Workspace](../../CONTEXT.md); a Project sits either directly in its Workspace or in exactly one of its Folders.
- A Folder is a label, not ownership: it carries no members and no permissions, so visibility follows the Workspace and moving a Project into a Folder changes nothing about who sees it.
- Folder names are unique within a Workspace, compared case-insensitively.
- Anyone who can open the Workspace can create, rename, delete and move its Folders; for a shared Workspace that includes holders of `can_manage_workspaces` who are not members.
- Moving a Folder to another Workspace carries its Projects in one transaction and applies the same rules as moving those Projects themselves ([Workspaces](workspaces.md)).
- In the sidebar a Folder is a drop zone for Project rows and is itself draggable onto another Workspace group.

## Edge cases

- When a Folder is deleted, its Projects are released to the Workspace; nothing else is removed.
- When a Folder is moved to the Workspace it is already in, nothing changes.
- When a Folder is moved into a [Personal Workspace](../../CONTEXT.md), the move is refused.
- When a Workspace is deleted, its Folders are deleted with it.

## Code

- `backend/src/workspace/` — Folder routes and the create, rename, move and delete rules.
- `folders` in `backend/db/schema.ts` — the table and its case-insensitive name index.
- `frontend/src/components/folder-dialog.tsx` — create and rename UI.
- `frontend/src/lib/sidebar-dnd.ts` — the sidebar drop zones and Folder drag identity.

## Related

- [Workspaces](workspaces.md) — who sees a Workspace and the rules for moving Projects between them.
