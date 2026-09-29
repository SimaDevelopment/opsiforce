# Pods view reads keep-alive live from Redis, never from k8s or a new durable store

The per-Organization **Pods** operational view shows, for each running ProjectEnvironment pod, when it was last kept alive and by which Keep-alive activity (agent vs app). That data is split across three stores: Kubernetes knows which pods exist and their identity/health; Redis holds keep-alive (two TTL keys per env whose *value* is the last-touch time and whose TTL is the countdown to expiry); Postgres holds names and the timeout policy. We make Kubernetes the source of truth for the **row set** — enumerate `app=opsiforce-agent` pods from the informer cache, intersected with the Organization's projects — and read keep-alive **live from Redis** as a join at request time. We deliberately do not persist keep-alive anywhere new, and in particular do not write it into pod labels or annotations.

## Why not annotate the pod

Keep-alive is touched on every proxied request (every chat token stream, every app hit). Writing it onto the pod would mean a Kubernetes API write — and therefore an etcd write — per request, and would bump the pod's `resourceVersion` on every touch, storming the very informer cache the view relies on. Using the API server as a database for high-frequency mutable state is a known anti-pattern. Redis already records the data for free, with the same TTL semantics that drive suspension.

## Consequences

- Once a TTL key expires, its exact last-touch time is gone, so the view shows "idle > {timeout}" for that activity rather than a precise timestamp. This is acceptable for a live operational view — the actionable signal is what is keeping the pod alive *now* and when it will suspend (`max` of the two remaining TTLs).
- If durable per-kind keep-alive history is ever required, the cheap path is to split the existing `project_environments.last_active_at` write (which already happens on every touch) into per-kind columns — not pod annotations.
- The view surfaces drift (a pod whose DB status ≠ `active`; an env marked active with no pod) precisely because Kubernetes, not the DB, drives the row set. This is the same authority model as the rest of the [pod lifecycle](../runtime/pod-lifecycle.md), applied to a read view.
