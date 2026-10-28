---
kind: explanation
terms: [Keep-alive activity]
adrs: [0019, 0094]
---

# Pod Lifecycle

> How does a ProjectEnvironment's pod come to exist, recover when it breaks, and suspend when idle?

## How it works

### Kubernetes is authoritative

- The running unit is the [ProjectEnvironment](../../GLOSSARY.md); each owns a status and a workspace directory ([Environments](../projects/environments.md)).
- Pod existence is looked up by the deterministic name `opsiforce-agent-{environmentId[:8]}`, which is never persisted; readiness and failure reason are read from the pod's status, and the last attempt time from its creation timestamp.
- Every caller reaches a pod at `<pod name>.opsiforce-agents.<namespace>.svc.cluster.local`, the DNS name one headless Service over every agent pod gives it; the database stores no address, so a pod that comes back with a new IP needs no repair ([ADR-0094](../adr/0094-agent-pods-are-reached-by-dns-name-and-the-database-stores-no-address.md)).
- Two writers converge without locks: pod creation treats a 409 AlreadyExists as success, and every status transition is a conditional `UPDATE … WHERE status = '<expected>'` whose loser updates zero rows and stops.

### Startup

- A new [Project](../../GLOSSARY.md) claims a running environment from the [pending project pool](pending-project-pools.md); every other path is the ensure dispatcher the runtime proxies call before forwarding ([Request Flows](request-flows.md)).
- The dispatcher wakes a `suspended` environment, checks Kubernetes for a `starting` one, and serves an `active` one whose pod the informer reports Ready; a startup worker creates or adopts the pod, waits on informer events for Ready, and flips the row to `active`.

```
                    ┌──────────────────────────────────────────────┐
        admin       │                  disabled                    │
       disable ────▶│   project-level flag; auto-wake blocked;      │
     (project)      │   admin must re-enable                        │
                    └──────────────────────────────────────────────┘

   ┌──────────────────────┐         ┌────────────────────────────────────┐
   │      suspended        │ access  │              starting              │
   │ no pod; workspace      │───────▶│ pod should exist — check K8s:       │◀─┐
   │ preserved on disk      │        │  Ready         → active             │  │
   │                        │        │  Pending       → 503, let it cook   │  │
   │ wake:                  │◀───────│  CrashLoop>60s  → delete, recreate  │  │
   │  UPDATE … WHERE        │        │  ImagePullBackOff → failed          │  │
   │   status=suspended     │        │  missing        → spawn startup     │  │
   └──────────────────────┘         └────────────────────────────────────┘  │
              ▲                               │              ▲                │
   both TTLs expire AND status=active         │ pod Ready    │ proxy 5xx +    │
   (conditional UPDATE protects an            ▼  UPDATE)     │ K8s pod gone   │
    in-flight startup)        ┌────────────────────────────────────┐         │
              │               │                active               │─────────┘
              └───────────────│ pod Ready, serving                   │
                              └────────────────────────────────────┘

   Every arrow is a conditional UPDATE WHERE status='<expected prev>'.
```

### Recovery

- A pod delete event (kubectl, eviction, node drain, OOMKill) resolves the environment from the pod's label and, for an enabled `active` environment with live keep-alive timers whose pod is confirmed gone, flips it to `starting` and spawns the startup worker, so a pod with the same name is back against the persisted workspace within seconds ([ADR-0019](../adr/0019-externally-deleted-pods-recreated-eagerly.md)).
- Self-inflicted deletions (suspend, restart, publish, disable) match zero rows in that flip because every internal flow moves the row out of `active` before deleting the pod.
- A boot pass deletes orphaned agent pods, resumes workers for environments stranded in `starting`, and flips `active` environments whose pod is gone back to `starting`; only a confirmed absence counts, so a control-plane blip never mass-flips the fleet.
- A pod in CrashLoopBackOff is given 60 seconds, then deleted and recreated; ImagePullBackOff is terminal and moves the environment to `failed` with a Restart action.
- A Ready pod whose runtime answers a [Connection](../public-api/connection.md)'s `GET /api/info` with anything but 200 — a pod still on an older build, or a wedged runtime — is asked again for up to ten seconds, capped at half of connect's remaining budget, then recreated while connect answers starting; connections that meet the same pod together recreate it once. When the pod that replaced it refuses too within ten minutes, the environment moves to `failed` and that pod is deleted, so a recreate never loops.

### Suspension

- Each environment has two Redis TTL keys, one per kind of [Keep-alive activity](../../GLOSSARY.md): agent activity and app activity. Each kind has its own idle timeout and the pod is suspended only once both have expired. The ProjectEnvironment serving a [Custom External Service](../../GLOSSARY.md) at its Default environment is never suspended for idleness ([ADR-0083](../adr/0083-a-custom-external-services-default-environment-never-sleeps-its-state-lives-in-that-environments-workspace-and-is-copied-on-a-switch-and-its-webhook-url-belongs-to-the-service.md)).
- A Working Agent keeps the agent key alive: the backend touches it when a run starts, on each 60-second re-read while the environment is Working, and when it turns Idle, so the agent idle timeout counts from when the Agent goes Idle and a run driven from the Public API or a closed tab is never suspended mid-turn ([Agent Status](../agent-system/agent-status.md)). There is no cap on Working, ours or opencode's; a stuck level is cleared by the re-read, and a run waiting on a question or permission nobody answers holds the pod until someone answers or interrupts it.
- Expiry is delivered by Redis keyspace notifications (`notify-keyspace-events Ex`, set in the Redis deployment); the listener suspends with the conditional update, deletes the pod, and is backstopped by a startup sweep for expiries missed while the backend was down.

## States

Statuses of a ProjectEnvironment.

| State | What happens |
|---|---|
| `suspended` | No pod; the workspace is preserved on disk; the next access wakes it |
| `starting` | A pod should exist; each access checks Kubernetes and answers 503 until Ready |
| `active` | Pod Ready and serving; both keep-alive timers running |
| `publishing` | Files are being swapped and the pod rebuilt by a [Publish](../projects/publish.md) |
| `failed` | The image cannot be pulled, or a replacement pod's runtime refused too; Restart recreates the pod |
| disabled | Project-level flag: every environment that has or is getting a pod is `suspended` with its pod torn down, a Publish in flight finishes, and auto-wake is blocked until an admin re-enables |

## Edge cases

- When an idle timeout expires as a user returns, the listener's conditional update affects zero rows if a startup already moved the row, and it exits without touching Kubernetes.
- When the backend crashes mid-startup, the next access reads Kubernetes and either flips to `active` or spawns a fresh worker; there is no boot-time recovery state machine.
- When a deletion is missed during an informer reconnect gap, the boot sweep or the next failed request catches it; there is no interval reconciler.
- Recovery reads keep-alive timers but never refreshes them, so a recovered environment keeps its original suspension schedule.
- When the Kubernetes API is unavailable, ensure answers 5xx and the frontend retries.

## Code

- `backend/src/pod/` — deterministic naming, the pod address and the only way to call a pod, pod creation, readiness wait, failure inspection, the informer.
- `helm/opsiforce/templates/agents-service.yaml` — the headless Service that gives every agent pod its DNS name.
- `backend/src/project/project.service.ts` — the ensure dispatcher, its branch handlers and the startup worker.
- `backend/src/timeout/` — the two keep-alive keys, the expiry listener and the startup sweep.
- `backend/src/pool/` — the pending project pool a new Project claims from.

## Related

- [Request Flows](request-flows.md) — the proxies and the ensure gate that drive every transition.
- [Pending project pools](pending-project-pools.md) — how a new Project starts already running.
- [Pods](pods.md) — the Admin view of running pods and their keep-alive.
- [Persistence](persistence.md) — what survives a pod replacement.
- [Publish](../projects/publish.md) — the `publishing` status and the pod rebuild.
