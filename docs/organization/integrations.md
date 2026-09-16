---
kind: explanation
---

# Integrations

> How does an [Organization](../../CONTEXT.md) map itself to its tenant in the platform's managed identity provider, and what happens when the mapping changes?

## How it works

- When [App Auth](../../CONTEXT.md) runs in managed mode, an App's OIDC middleware asserts a tenant-scoped realm role built from the configured role prefix and the Organization's external tenant name, which must match how the tenant is named in the identity provider ([Environments](../projects/environments.md)).
- The Organization's name and its external tenant name are not always identical, so the tenant settings row stores the explicit mapping.
- A tenant admin picks the external tenant under Settings, Integrations from a dropdown of their own group memberships filtered by the role prefix, and the backend re-validates the choice against the groups header on save ([Settings](settings.md)).
- When the mapping changes, every [Project](../../CONTEXT.md) in the tenant using managed auth is re-synced in the background through a BullMQ queue, one job per Project with a deterministic id so rapid re-saves collapse and failures stay isolated.
- Reading the mapping is open to any tenant member; changing it requires `can_manage_external_integration` ([Permissions](permissions.md)).
- New tenants get their row in the same transaction as the tenant, so the resolver needs no fallback.

## Code

- `backend/src/private/tenant-settings/` — the mapping, the sync queue and its processor; part of the private seam, excluded from the standalone mirror.
- `backend/src/tenant/tenant.service.ts` — resolving a tenant by external name and parsing groups by prefix.
- `frontend/src/private/integrations/` — the Settings section.

## Related

- [Settings](settings.md) — the surface this is a section of.
- [Environments](../projects/environments.md) — the managed App Auth mode that consumes the mapping.
- [Permissions](permissions.md) — the permission that gates changes.
