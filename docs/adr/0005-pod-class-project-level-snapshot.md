# Pod class is project-level policy, snapshotted per project

We configure the agent pod's size ("pod class") per **`Project`**, in a dedicated 1:1 `project_pod_settings` table (a `pod_class` enum plus `cpu_millicores`/`memory_request_mib`/`memory_limit_mib`), **not** per `ProjectEnvironment` — even though the pod is physically per-env. Four classes exist: `small`/`medium`/`large` presets and `custom`; the catalog (preset numbers + custom min/max caps) is **hardcoded** in the backend and served via `GET /pod-classes`. Storage is **numbers-authoritative**: selecting a preset snapshots the catalog's current numbers into the row, `custom` stores the typed-and-clamped numbers, and `buildPodSpec` reads the three integers — one uniform path with no preset/config branching. A `can_manage_project_pod_settings` permission gates a dedicated `PUT /projects/:id/pod-class`.

We chose this to mirror ADR-0001's split: owner-set *policy* (budget, timeouts, timezone) lives on the `Project`; per-instance *runtime* (directory, pod, status, `authMode`, credentials) lives on the `ProjectEnvironment`. Pod class is desired policy, not observed runtime, so it sits with budget/timeouts — and per-env pod-class overrides join the same deferred list those settings already have. We snapshot numbers rather than resolving presets live so a row fully describes the pod it produces (a one-`SELECT` answer to "why 4Gi / why OOMKilled"), the build path stays uniform, and a config edit never silently resizes the running fleet. We hardcode the catalog because, under snapshot storage, the numbers are read only at selection time — Helm/tenant config would *look* live but would not be.

## Considered options

- **Per-`ProjectEnvironment` storage** (dev ≠ prod sizing immediately) — rejected for v1: diverges from the project-level budget/timeout precedent and adds per-env UI surface; kept as a deferred override.
- **Config-live preset resolution** (`buildPodSpec` re-reads config each build) — rejected: two sources of truth (config + row) that drift, and a preset row cannot state its own numbers.
- **Helm / tenant-overridable catalog** — rejected for v1: it adds tenant-defaults storage, a defaults UI, and a permission, and snapshot storage mutes the re-tune benefit that would justify it.

## Consequences

- A published **Production** pod runs at the **same class as Development**; sizing prod above dev is impossible until per-env overrides ship.
- Re-tuning a preset (what "medium" means) is a code change **plus** an explicit backfill (`UPDATE … WHERE pod_class = 'medium'`); it never reaches existing projects automatically.
- The pending pool stays homogeneous (always `small`): a new or pool-claimed project's **first** pod is `small`, and a chosen class materializes only on the next pod rebuild — resources are immutable on a running pod, so applying a class is always a pod recreate, never an in-place resize.
- Changing class is non-destructive (it writes the row) and applies on next idle-resume or via an explicit "Restart to apply" on the current env; publishing brings a prod pod up at the project's current class by construction.
- There is no Helm `agentResources` value. Every pod reads its Project's row; pool slots are pending Projects whose row is `small` ([ADR-0041](0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md)).
