---
kind: explanation
terms: [Form, Service configuration, Project configuration, Available]
adrs: [0079, 0080, 0089]
---

# Configuration

> Where are an External Service's two configurations stored, who edits them, and what happens when one is saved or its manifest changes?

## How it works

### Two levels

- A [Service configuration](../../GLOSSARY.md) is one `external_service_configs` row per service and owner: the platform's for a [Built-in External Service](../../GLOSSARY.md), edited by the platform operator on its Store page (`PUT /api/external-services/platform/services/<id>/configuration`, `can_manage_platform_external_services`), and the Organization's for a [Custom External Service](../../GLOSSARY.md) (`PUT …/services/<id>/configuration`, `can_manage_tenant_external_services`), which also has Development's own row that only test calls read ([External Service Builder](external-service-builder.md)).
- A [Project configuration](../../GLOSSARY.md) is one `external_service_project_configs` row per service and ProjectEnvironment, GIN-indexed for Event routing. Next to the [Form](../../GLOSSARY.md)'s values it holds the reserved keys `operations` (one switch per Operation), `receive` (one switch per Event type) and `_labels` (the label of every value picked from a callback), which service code never sees.
- Every `secret` is sealed with AES-256-GCM under `EXTERNAL_SERVICES_ENCRYPTION_KEY`, its associated data naming the service by its id, the owner (`platform`, the tenant id, plus `+development` for Development's row) and the field path with item ids, so a value opens only where it was sealed ([ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)). The backend refuses to boot without a well-formed key, and the Helm chart refuses to render without one.
- A service is [Available](../../GLOSSARY.md) while its callers' Service configuration validates against its Service form: until then the operator's page says "Needs setup", no Organization sees it in the Store, the chat bar or an Agent's picker, and the [Gate](gate.md) answers `503 service-not-configured`.

### Reading against a changed manifest

- Stored values are kept as saved and read against the current manifest tolerantly: a field's `was` moves an old value to its new key, a value that no longer fits counts as missing (a required one makes the configuration "Needs attention", naming each such field by its labels, such as "Numbers › Number", and the Gate answer `409 configuration-incomplete`), removed keys stay stored but are never delivered, and an Operation or Event type missing from the stored switches reads as off ([ADR-0079](../adr/0079-a-changed-service-manifest-reads-old-configurations-tolerantly-and-never-turns-on-new-operations.md)).
- A new Project configuration switches reads on and writes and destructive Operations off, and every Event type off; a new Skill & Agent Builder chat starts with a `public-api` one whose authoring writes are on too ([Public API built-in](public-api.md)).
- A Project of a Custom Agent starts with a stored Project configuration for every Available service whose [Service settings (Agent)](../../GLOSSARY.md) its Agent Profile holds: on create (UI, Public API, Workspace) and for the Agent's [Test Project](../agent-system/test-project.md) it is written before the Agent's files are delivered and announced after, for a Project Duplicate or Import once the files are in place, its Service skills delivered before the hook runs. Exactly the Operations and Event types the settings name are on and no target is picked. A complete configuration runs `onProjectConfigurationSaved` with the Project's creator; a failure is the usual "Saved, but …" and the Project is still created. One a required target leaves "Needs attention" runs no hook until someone saves it with the targets picked ([ADR-0089](../adr/0089-a-custom-agents-service-settings-seed-a-real-project-configuration-in-every-new-project.md)). Every save stores a switch for every declared Operation and Event type, so a name absent from the stored switches is one added since, marked "new · off" in the dialog.

### Where Project configurations are edited

- `/api/external-services/projects/<projectId>/environments/<projectEnvironmentId>/services` serves the chat bar under a Project's composer: every service Available to the Organization, each `enabled` (a configuration is stored here), `needs-configuration` (the Agent carries its [Service skill](service-skill.md), nothing is stored here) or `available` (neither), with its configuration state; one service's Project configuration (secrets masked, Service configuration items by label only, the `missing` fields); and `PUT …/<serviceId>/configuration`, whose first save enables the service here and delivers its Service skill to this ProjectEnvironment. Anyone who can open the Project reads; saving needs `can_configure_project_external_services`.
- Form calls let a form ask its service while someone edits it: `POST …/<serviceId>/{options|info|buttons}/<name>` under the chat bar's prefix, the operator's `platform/services/<id>/…` or the Organization's `services/<id>/…`, each with `{values, query?, item?}`. `values` are the unsaved values with stored secrets merged into blank secret boxes on the server; a callback inside a `list` item names the item and gets the Service configuration cut to it; a Project form call carries `ctx.caller` for the environment being edited. Form calls time out after 10 s, skip switches and bounds, never write configuration, pass the Gate's answer checks and write one Call of kind `form`; an unknown name is `404 unknown-callback`.
- The renderer (`external-service-form/`) is the same for every service and level: chips, searchable and dependent pickers, "no longer found" for a stored pick a callback stopped returning, "stored · encrypted" with Replace, the one-time reveal, Rotate, `info` Copy and badges, button results and the Operations and Receive switches.

### Saving

- Every save of either level goes through one form save. A `list` item gets a platform id (`li_…`) on its first save and keeps it, so references, trimming and sealing places follow the item; a blank secret keeps the stored one; callback-sourced values are only shape-checked.
- A `generate` field empty on save is filled by the platform, so the form never asks for it even when it is `required`; in the Project form of a service that declares Events, only once the configuration receives an Event type. `unique: true` (on `text` only) is checked on save against every other configuration of the service, in the save's transaction under a lock per service and field: a generated collision is generated again, a typed one answers `400 invalid-configuration` "is taken", and a value the configuration already stores is never taken from it, even when another configuration holds it too. The save response's `revealed` carries each secret it generated, once; afterwards it reads `{stored: true}` and a lost value means Rotate.
- Rotate (`POST …/configuration/rotate {field, item?}`) generates a new value for one generated field, reveals a secret once and counts as a save. A built-in's new manifest that declares `generate` on a field stored configurations left empty is filled at boot, without a hook.
- After-save hooks run after the commit: `onServiceConfigurationSaved` with the whole Service configuration, `onProjectConfigurationSaved` with the Service configuration cut to the items either version picks, both with `{previous, current}` opened, 10 s, one Call of kind `hook`. A failure never rolls the save back: the response carries `hookFailure` ("Saved, but … [Discard] [Retry]"), `previous` stays the last version the service acknowledged (`null` for a Project configuration stored while it still "Needs attention", whose hook never ran, and a goodbye with `current: null` skips such a configuration), kept on the configuration itself with any secret moved by a `was` rename sealed again at its new key, and `POST …/configuration/hook/retry` (Development's: `…/development/configuration/hook/retry`) runs it again, while `POST …/configuration/hook/discard` (Development's: `…/development/configuration/hook/discard`) forgets the pending hook without calling the service, under the same permission as a retry. Form saves, Rotate, a Copy from Production into Development, a Publish carry, the cascade below and a service's Delete (`current: null`) all fire hooks.
- Saving the callers' Service configuration without a `list` item strips every Project configuration's reference to it in the same transaction, logs it, fires that Project configuration's hook and leaves a notice its dialog shows once.

## Edge cases

- When a hook fails or times out, the values stay saved and the page offers Retry until a hook answers, or Discard to stop waiting for the service to apply that save.
- When a Publish (App) carries a Project configuration, it overwrites the target's values and switches, hands Receive over and never copies a unique generated value ([Publish](../projects/publish.md)).
- When a Project or a ProjectEnvironment is deleted, each of its Project configurations first runs `onProjectConfigurationSaved` with `current: null` on the version that environment reaches (best effort, 10 s, skipped while the service is disabled), then goes.
- When a typed value of a `unique` field is already held by another configuration, the save answers `400 invalid-configuration` and stores nothing.

## Code

- `backend/src/external-services/configuration/` — both stores, the form save, generated values, Rotate, hooks, the cascade, tolerant reads and Available.
- `backend/src/external-services/http/` — the operator, Organization and chat bar routes.
- `backend/src/external-services/test-lane/configurations-at-create.ts` — the configurations a new Project starts with: the service under test and a Custom Agent's Service settings (Agent).
- `backend/src/common/secret-crypto.ts` — the place-bound sealing.
- `frontend/src/components/external-service-form/` — the one renderer every Form goes through.
- `frontend/src/components/project/external-services/` — the chat bar button and the Project configuration dialog.

## Related

- [Service manifest](service-manifest.md) — the field catalog the Forms are written in.
- [Gate](gate.md) — the reader of both configurations on every call.
- [Publish](../projects/publish.md) — carrying Development's Project configurations to a published environment.
- [Service skill](service-skill.md) — the skill a configuration delivers, and the Agents that carry it.
- [Permissions](../organization/permissions.md) — who edits which level.
