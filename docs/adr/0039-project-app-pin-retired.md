# Project app pin retired

ADR-0001, ADR-0007 and ADR-0016 each carried a Pin: one App per Project designated to represent it in the tenant-wide app catalog, gated on the pinned environment's App Auth being public and enforced by a one-pin-per-Project index. The catalog stopped discovering Apps through the platform when navigation became configurable, so the pin lost its only reader and was removed (migration 0052 drops `is_pinned`, `pinned_by_id` and `pinned_at` from `project_app`). Each ProjectEnvironment is its own App, addressed directly by its own URL; nothing selects one of them to stand for the Project.

## Consequences

- The Pin consequences in ADR-0001 (the catalog lists public Apps only), ADR-0007 (Pin managed per environment, unpinned on delete) and ADR-0016 (the partial unique index, catalog reads the pinned row) no longer hold; those ADRs stay accepted for everything else they decide.
- The `can_pin_apps` permission is removed; `can_edit_app_details` remains the only App Details permission.
