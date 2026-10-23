---
kind: operations
---

# Add a permission

> Add a new `can_*` permission so the UI can gate on it and the backend enforces it.

## Prerequisites

- A name for the permission in the `can_*` form; a `platform_` segment if its view spans all [Organizations](../../GLOSSARY.md) ([Permissions](../organization/permissions.md)).
- Access to the Keycloak Pulumi stack.

## Steps

1. Pulumi. In `packages/infra/pulumi/keycloak-configurator/opsiforce/`, add the role to `OPSIFORCE_ALL_PERMISSIONS` and to one bundle: `OPSIFORCE_ADMIN_GROUP_PERMISSIONS` for an Organization permission, which gets no group of its own; `OPSIFORCE_PLATFORM_ADMIN_GROUP_PERMISSIONS` for a platform-scope one, which also gets its own group with `createGroupWithRoles()`. Never put one permission in both bundles.
2. Frontend. Add the constant to `frontend/src/constants/permissions.ts` and gate the UI with `hasPermission()`.
3. Backend. `GET /api/permissions` returns the new role automatically, so gating works with no backend change; to enforce it, add the string to `Perms` in `backend/src/permission/permission.constants.ts` and guard the routes with `@RequirePermission`. A route without the guard stays open to any authenticated member.
4. Local. The static-mode identity mirrors the permission enum in the `opsiforce-proxy` chart's hardcoded list; add the role there so local development keeps full access ([Local orchestration](local-orchestration.md)).

## Verify

- `GET /api/permissions` lists the new string for a member of the bundle it joined (`opsiforce_admin` or `opsiforce_platform_admin`).
- The guarded route answers 403 for a member without the permission and succeeds for one with it.
- The UI hides the gated control for a member without it.
