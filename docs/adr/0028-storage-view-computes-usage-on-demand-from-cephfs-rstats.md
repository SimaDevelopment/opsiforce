# Storage view computes usage on demand from CephFS rstats — no usage table

The Admin **Storage** view shows per-directory disk usage on the shared CephFS claim, rolled up Tenant → Project → ProjectEnvironment. The reflexive design is a periodic scan job writing rows into a Postgres table (the shape `external_service_usage` uses). We do the opposite: the backend computes the whole snapshot **at request time** — one `ceph.dir.rbytes` xattr read per directory of interest plus one quota-aware `statfs()` for claim totals — behind an in-process memo with a ~30 s TTL. No table, no scan job, no durable cache.

## Why no table

CephFS maintains recursive statistics (rstats) per directory in the MDS itself; reading `ceph.dir.rbytes` is O(1) regardless of subtree size. The filesystem *is* the pre-aggregated store, so a Postgres cache would add a second source of truth and its own staleness while saving almost nothing — the request-time cost is N directories × one MDS getattr, sub-second at our scale. `external_service_usage` is not the precedent to follow here: it records events that would otherwise be lost; disk usage is re-derivable from the filesystem at any moment. This is the same authority model as [ADR-0013](0013-pods-view-reads-live-keepalive-from-redis.md): Admin observes, it does not become a new source of truth.

## Freshness

rstats are propagated lazily by the MDS — values may lag writes by up to ~30 s. The memo TTL is set to match that lag, which means a force-recompute control cannot deliver fresher truth than waiting out the memo; the view therefore has **no refresh button**. The response carries a `computedAt` timestamp and the UI discloses "sizes may lag recent writes by ~30 s".

## No walk fallback in cephfs mode

If an xattr read fails in cephfs mode (`STORAGE_TYPE`), the view surfaces an explicit per-directory error — it never falls back to a du-style walk, which on the real volume is millions of MDS ops. The bounded recursive walk exists only for the hostPath dev mode, where trees are small.

## Consequences

- The backend image gains the `attr` package (46.5 KiB) so the service can shell out to `getfattr --only-values -n ceph.dir.rbytes <dir>`. Node has no xattr API; the maintained-native-module alternatives were weighed and rejected (see the storage-overview research notes) because the MDS round-trip is the latency floor either way.
- A burst of admins or an auto-refreshing tab costs one recompute per 30 s per backend pod; pods do not share the memo, which is acceptable because recomputation is cheap.
- If the view ever needs historical trends, that is a new decision — this ADR covers the current-state snapshot only.
