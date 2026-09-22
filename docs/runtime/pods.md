---
kind: explanation
terms: [Pods]
adrs: [0013]
---

# Pods

> What does the Pods page in Admin show about an [Organization](../../CONTEXT.md)'s running pods, and where do its numbers come from?

## How it works

- [Pods](../../CONTEXT.md) is the first page of [Admin](../organization/admin.md): one row per running [ProjectEnvironment](../../CONTEXT.md) pod, grouped by [Project](../../CONTEXT.md) with Development first, showing status, age, [Resources](../../CONTEXT.md) class, configured idle timeouts and live [Keep-alive activity](../../CONTEXT.md).
- Keep-alive renders as two colour-coded tracks, agent activity and app activity, plus one "suspends in" line, the later of the two ([Pod Lifecycle](pod-lifecycle.md)).
- The countdown is sent as a remaining duration, so it ticks correctly regardless of clock skew.
- Kubernetes drives the row set: the agent-pod informer cache intersected with the selected Organization's Projects. Postgres supplies names, timeout and Resources policy and tenant attribution; Redis supplies keep-alive, read live from the two keys whose value is the last touch and whose TTL is the countdown ([ADR-0013](../adr/0013-pods-view-reads-live-keepalive-from-redis.md)).
- Because Kubernetes drives the row set, drift (a pod running while its environment is marked suspended, disabled or failed) is flagged inline and a ghost (an environment marked active with no pod) is a per-Project footnote.
- Pending-pool pods are excluded; they belong to no Organization.
- Gated by `can_view_pods` ([Permissions](../organization/permissions.md)) and scoped to the selected Organization; the only action is a deep link to the Project.

## Code

- `backend/src/admin/` — the pods overview endpoint and the three-store join.
- `backend/src/timeout/` — the batched keep-alive read.
- `frontend/src/pages/pods.tsx` — the page, mounted under the Admin routes.

## Related

- [Admin](../organization/admin.md) — the section this page opens.
- [Pod Lifecycle](pod-lifecycle.md) — what the statuses mean and how suspension works.
- [Resources](resources.md) — the class shown per row.
