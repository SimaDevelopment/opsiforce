---
kind: explanation
terms: [Storage, Pending deletion, Unattributed storage]
adrs: [0028]
---

# Storage

> How does the Storage page measure who holds how much of the shared volume, and what does the rest of the volume hold?

## How it works

### Accounting

- [Storage](../../CONTEXT.md) measures one leaf, the [ProjectEnvironment](../../CONTEXT.md) directory, and rolls it up into [Project](../../CONTEXT.md) and [Organization](../../CONTEXT.md) totals.
- Each Organization also carries [Pending deletion](../../CONTEXT.md): its tombstoned directories still inside the retention window ([Persistence](persistence.md)), counted as one bytes-plus-count aggregate inside the Organization's total.
- Each Organization also carries its Agents' [Templates](../../CONTEXT.md): every `agent-templates/<agentId>/` folder is measured whole and attributed through `agents.tenant_id`, so a version several Environments link to is counted once, and the bytes-plus-Agent-count aggregate sits inside the Organization's total ([Template](../agent-system/template.md)).
- [Unattributed storage](../../CONTEXT.md) buckets sit at the volume root: pool slots, tenant-less tombstones, orphaned directories, Template folders with no Organization (an Agent row already gone, awaiting the sweep), and the export and import staging areas.
- The snapshot reconciles: unaccounted is the claim's used bytes minus everything attributed, signed on the wire because a negative residual means the filesystem's recursive statistics lag recent writes.

### Measurement

- Nothing is stored: the backend measures on demand and memoizes the whole snapshot in-process for about thirty seconds, the order of CephFS's own propagation lag ([ADR-0028](../adr/0028-storage-view-computes-usage-on-demand-from-cephfs-rstats.md)).
- The strategy follows `STORAGE_TYPE`: on CephFS a directory's size is one read of its `ceph.dir.rbytes` attribute through `getfattr`; under hostPath the tree is walked with bounded concurrency.
- Capacity and used bytes come from a quota-aware `statfs`; the enforced quota is read from the mount root's quota attribute and compared coarsely against `statfs`, with `STORAGE_CLAIM_SIZE` only as a fallback when the attribute is unreadable.

### The page

- A segmented capacity bar leads: one band per Organization, one grey band for the unattributed buckets, amber for unaccounted, the rest free; beneath it one expandable ledger drills Organization to Project to ProjectEnvironment with size, share and a proportional bar.
- Pending deletion shows as an outline badge on the Organization row; an Organization's Templates show as an Agent Templates row above its Projects; orphaned directories show a count beside their bytes; unaccounted closes the table as a footer row.
- Gated by `can_view_platform_storage`, a [Platform-scope permission](../../CONTEXT.md) that ignores the Organization selector ([ADR-0027](../adr/0027-platform-scope-routes-opt-out-of-tenant-resolution.md), [Permissions](../organization/permissions.md)); `can_manage_platform_storage` adds a Clean up now control that runs the cleanup job for one Organization with the retention window ignored.

## Edge cases

- When a directory cannot be measured, it reports an error that propagates up the rollup; on CephFS there is no fallback to walking.
- When a measured directory no longer exists, it reads as zero in both modes.
- When the quota attribute is zero or absent, capacity is reported as suspect: the page shows a warning, renormalises shares to what was measured and withholds the residual.
- When the residual is negative, the wire keeps the signed value and the screen clamps it to zero.
- Under hostPath the quota is always absent, so development always renders in the capacity-unverified mode.

## Code

- `backend/src/storage/` — the endpoint, the memo, the snapshot builder and the per-`STORAGE_TYPE` measurement strategies.
- `backend/src/cleanup/` — the cleanup job Clean up now enqueues.
- `frontend/src/pages/storage.tsx` — the capacity bar and ledger.

## Related

- [Persistence](persistence.md) — the volume being measured and the tombstone cycle behind Pending deletion.
- [Pods](pods.md) — the sibling Admin view, scoped to one Organization.
- [Pending project pools](pending-project-pools.md) — the pool bucket.
