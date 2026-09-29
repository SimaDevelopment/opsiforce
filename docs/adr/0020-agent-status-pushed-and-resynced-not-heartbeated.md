# Agent Status is pushed from the pod and re-synced at boundaries — no heartbeat, no persistence

The sidebar needs a per-project signal that the Agent is Working (see Agent Status in `CONTEXT.md`) — for **all** of a user's projects at once, including projects whose chat no browser has open. The only source of truth is OpenCode inside each pod: it tracks a per-session `SessionStatus` (`busy | retry | idle`), emits a `session.status` event on every transition, and answers `GET /api/session/active` with all currently non-idle sessions.

**The pod pushes transitions; the backend re-reads truth wherever state could have been lost.** The in-pod `agent-control` process subscribes to OpenCode's event bus and pushes Working/Idle transitions over the existing Service Gateway channel — the second producer on the pod→backend push path established by ADR-0015, with the same at-least-once/idempotent delivery. The backend holds the level per ProjectEnvironment in memory (a sibling of `AppReadinessService`), publishes transitions on the existing Redis project-events bus, and fans them out on a user-scoped multiplexed SSE stream that filters to the connecting user's visible projects; `GET /projects` carries the current level (`agentStatus`, `'working' | 'idle'`) so the sidebar is correct at first paint. A session in `retry` counts as Working — a provider backoff is mid-run, not done — and an environment is Working when any of its sessions is non-idle, which covers sub-agent sessions.

There is deliberately no heartbeat. ADR-0015 keeps app liveness on edges, not a heartbeat; here the stronger reason is that OpenCode's status is *queryable at rest*, so staleness is repaired by re-reading rather than by continuously proving liveness:

- `agent-control` re-reads `GET /api/session/active` locally and pushes a snapshot on boot and whenever its event-stream subscription reconnects — unconditionally, even an unchanged or Idle level, because the backend's level may have gone stale during the gap (a run that finished while the process was down must still clear). Self-healing for pod restarts, container crashes, and its own crashes (k8s brings it back; it pushes truth).
- The backend clears the level at every environment-lifecycle boundary it drives (suspend, restart, disable, fail, delete) — a pod that stops existing cannot be Working.
- On backend boot, a one-shot reconcile reads `/api/session/active` of active environments' pods through `agent-session`, retrying with backoff only the environments it could not read — bounded, not polling.

## Considered options

- **Heartbeat + TTL** — pod re-affirms Working every ~30s, backend expires silence. Correct by construction, rejected: continuous chatter from every busy pod to defend state OpenCode already holds queryably, and 0015 refuses the same pattern.
- **Infer from proxy traffic** — rejected: the proxy sees OpenCode's event stream only while a browser is attached, and the no-browser case is the feature's whole point.
- **Polling** — backend probing pods, or a frontend `refetchInterval` on `GET /projects`. Rejected: N pollers or always-on refetch for a signal that is silent most of the time; contradicts 0015.
- **Persist in Postgres** — rejected: ephemeral runtime state; a no-TTL boolean reports a dead pod's agent as Working, the same failure 0015 refuses for `serving`.
- **Trigger on `session.idle`** — rejected: deprecated upstream, and detecting Working-start needs the `session.status` event anyway.

## Consequences

- A stuck spinner requires a pod that stays alive while `agent-control` stays permanently dead — a state the platform already treats as broken, since 0015's liveness relies on the same process. Every other loss path is healed by a snapshot push, a lifecycle clear, or the boot reconcile.
- The in-memory level assumes the single backend replica (`replicaCount: 1`, like `AppReadinessService`); scaling out moves it to Redis, as 0015 already prescribes for `serving`.
- Prompting a published environment's agent spins its project in the sidebar too — the level is per-ProjectEnvironment and the sidebar consumes the OR.
- The SSE stream computes the visible-project set (tenant + workspace membership) once per connection; reconnects recompute it, and project creation already refetches the list.
- Changing `agent-control` ships only via a new agent image and pod recreation — bump `agent-config/agent-image-version.json`; rollout mechanics as in 0015.
