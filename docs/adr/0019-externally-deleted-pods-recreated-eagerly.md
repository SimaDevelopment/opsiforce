# Externally deleted pods are recreated eagerly — at boot and on delete events

Pod recovery is otherwise lazy: the next request to an environment recreates its pod. That assumes pods die one at a time with a user nearby. A node replacement can delete every agent pod at once, and then environments sit in `active` with live idle-timers and no pod until each owner reopens their Project. Pending pool Projects already heal through the pool integrity job ([ADR-0041](0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md)); user environments need their own trigger.

**Decision: an environment the platform believes is running gets its pod back without waiting for traffic.** Two triggers, both funnelling into the existing conditional-flip + startup-worker machinery:

1. **Boot sweep** — the mirror of orphan cleanup, over the same data: every environment with `status = 'active'`, project enabled, idle-timers not fully expired, whose pod is absent → conditional `active → starting`, spawn the startup worker.
2. **Delete-event watcher** — a global informer `onDelete` subscription: pod delete event → resolve the environment from the pod's labels → same guard, same flip. Covers deletions that land while the backend is up (node drains are asynchronous to deploys — the fleet reacts minutes after the backend has already rebooted, so a boot-only sweep would have missed the very incident that motivated this).

Guard rails that keep this from becoming a new failure mode:

- **Only confirmed absence counts.** A K8s 404 (or a pod already carrying a `deletionTimestamp`) means missing; any other API error means *skip the environment*. Treating "can't tell" as "missing" would let a K8s API blip mass-flip every active environment into recreation — the kind of self-inflicted incident the K8s-authoritative lifecycle avoids.
- **Idle-timers are never refreshed by recovery.** An environment five minutes from suspension gets its pod back and still suspends five minutes later; scale-to-zero economics are untouched, and fully-expired environments are left for the suspension sweep.
- **Self-inflicted deletions no-op for free.** Suspend, restart, and publish move the row out of `active` *before* deleting the pod, and disable commits its project-level flag first; the watcher's conditional `UPDATE … WHERE status='active' AND project enabled` then matches zero rows — no allow-list of "our own" deletions to maintain.

## Considered options

- **Keep recovery lazy** — rejected: mass deletion plus no traffic equals silent downtime with a manual reopen per project as the only cure, and the platform's `karpenter.sh/do-not-disrupt` annotation is a request, not a guarantee.
- **Boot sweep only** — rejected: the deletion is asynchronous to the deploy that causes it. The backend chart change reboots the backend first; the fleet drains nodes after. The sweep would run while the pods were still alive.
- **Boot + interval sweep (the pool's pattern)** — rejected as heavier than the problem: with the watcher covering steady state event-driven, a polling reconciler adds bounded-staleness machinery for no additional coverage. The lifecycle doc's "no separate reconciler" stance holds: nothing polls.
- **Spec-hash rollout** (recreate running pods whenever the pod template changes) — out of scope: recreated pods pick up the current template anyway, so for the deploy case recovery doubles as rollout, and routine spec changes propagate through natural suspend/wake churn within hours. Deliberate rollout of urgent template changes already has a lever: an agent-update migration with `requiresPodRecreate`.

## Consequences

- A deploy that kills pods converges ~a startup-worker cycle after backend boot, and the recreated pods carry the new template — recovery is the rollout for everything that was running.
- Boot may recreate many pods at once after a fleet-scale deletion. Bounded by "recently active with live timers", and the workers are async; accepted rather than staggered until scale says otherwise.
- Steady-state pod *creation* remains lazy — nothing here creates pods for suspended, failed, or disabled environments; recovery only restores what the status row already promises.
