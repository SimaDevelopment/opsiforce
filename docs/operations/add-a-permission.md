---
kind: operations
---

# Add a permission

> Add a new `can_*` permission so the UI can gate on it and the backend enforces it.

## Prerequisites

- A name for the permission in the `can_*` form; a `platform_` segment if its view spans all [Organizations](../../GLOSSARY.md) ([Permissions](../organization/permissions.md)).
- Access to the Keycloak Pulumi stack.

## Steps

1. Backend. Add the name to `PERMISSIONS` in `backend/src/permission/permission.constants.ts`. This is Opsiforce's only copy: the frontend and the static identity read it from there ([ADR-0096](../adr/0096-the-frontend-and-the-static-identity-derive-their-permissions-from-the-backends-list.md)). To enforce it, guard the routes with `@RequirePermission('can_…')`; a route without the guard stays open to any authenticated member. `GET /api/permissions` returns the new name with no further change.
2. Frontend. Gate the UI with `hasPermission('can_…')`. The compiler accepts only names in `PERMISSIONS`, on both sides.
3. Keycloak. In `packages/infra/pulumi/keycloak-configurator/opsiforce/`, add the role to `OPSIFORCE_ALL_PERMISSIONS` and to one bundle: `OPSIFORCE_ADMIN_GROUP_PERMISSIONS` for an Organization permission, which gets no group of its own; `OPSIFORCE_PLATFORM_ADMIN_GROUP_PERMISSIONS` for a platform-scope one, which also gets its own group with `createGroupWithRoles()`. Never put one permission in both bundles. The Keycloak Configurator workflow previews the change on its pull request and applies it to the development realm on merge to `main`; production gets the role when `production-keycloak-configurator` is promoted, no later than the `production-opsiforce` release that gates on it.
4. Local. Tilt reloads when `PERMISSIONS` changes and redeploys `opsiforce-proxy`, so the static identity holds the new permission without a restart ([Local orchestration](local-orchestration.md)).

## Verify

- `GET /api/permissions` lists the new string for a member of the bundle it joined (`opsiforce_admin` or `opsiforce_platform_admin`).
- The guarded route answers 403 for a member without the permission and succeeds for one with it.
- The UI hides the gated control for a member without it.
