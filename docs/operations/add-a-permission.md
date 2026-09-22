---
kind: operations
---

# Add a permission

> Add a new `can_*` permission so the UI can gate on it and the backend enforces it.

## Prerequisites

- A name for the permission in the `can_*` form; a `platform_` segment if its view spans all [Organizations](../../CONTEXT.md) ([Permissions](../organization/permissions.md)).
- Access to the Keycloak Pulumi stack.

## Steps

1. Pulumi. Add the role to `OPSIFORCE_ALL_PERMISSIONS` (and to the admin group bundle if it belongs there; a platform-scope permission gets its own standalone group and stays out of the bundle) and create its group with `createGroupWithRoles()`.
2. Frontend. Add the constant to `frontend/src/constants/permissions.ts` and gate the UI with `hasPermission()`.
3. Backend. `GET /api/permissions` returns the new role automatically, so gating works with no backend change; to enforce it, add the string to `Perms` in `backend/src/permission/permission.constants.ts` and guard the routes with `@RequirePermission`. A route without the guard stays open to any authenticated member.
4. Local. The static-mode identity mirrors the permission enum in the `opsiforce-proxy` chart's hardcoded list; add the role there so local development keeps full access ([Local orchestration](local-orchestration.md)).

## Verify

- `GET /api/permissions` lists the new string for a member in the group.
- The guarded route answers 403 for a member without the permission and succeeds for one with it.
- The UI hides the gated control for a member without it.
