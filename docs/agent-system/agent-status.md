---
kind: explanation
terms: [Agent Status]
adrs: [0020]
---

# Agent Status

> How does the sidebar know a [Project](../../CONTEXT.md)'s Agent is Working without polling, and what keeps that signal from sticking?

## How it works

- [Agent Status](../../CONTEXT.md) is Working when the Agent is processing a run, provider retries included, and Idle otherwise; it is carried per [ProjectEnvironment](../../CONTEXT.md) and a Project is Working when any of its environments is.
- agent-control subscribes to OpenCode's event bus and tracks the set of sessions reported `busy` or `retry` by the native `session.status` event; Working is whether that set is non-empty, which covers sub-agent sessions as naturally as the root one.
- While the stream is up it pushes one idempotent `{working}` event over the Service Gateway channel only when the level changes; on boot and on every stream reconnect it re-reads OpenCode's active sessions and pushes the snapshot unconditionally, so a stale backend copy is repaired ([ADR-0020](../adr/0020-agent-status-pushed-and-resynced-not-heartbeated.md), [Service Gateway](../gateways/service-gateway.md)).
- The backend owns the level per environment in memory, keyed by the environment behind the pushing pod's gateway token, so a pod cannot report for another environment.
- The backend clears the level at every lifecycle transition it drives (suspend, restart, disable, fail, delete, the pod-recreating [Publish](../projects/publish.md)) and on boot re-reads every active environment's pod before the HTTP listener starts.
- The projects list carries `agentStatus` per Project, and the sidebar renders a small spinner with an "Agent working" label while Working.
- Live updates ride the Redis project-events bus into one user-scoped SSE stream per tab: on connect the backend computes the user's visible Projects with the same predicate as the projects list, emits each one's level, then forwards only transitions for those Projects.
- The frontend seeds a `projectId → agentStatus` store from the projects-list payload without clobbering fresher stream values, and the project row reads it.

## Edge cases

- The level lives in the single backend replica's memory, as App readiness does.
- When agent-control's binary changes, the feature lands only as pods are recreated onto the new image ([Agent Updates](agent-updates.md)).

## Code

- `proxy/cmd/agent-control/status.go` — the in-pod session watcher and snapshot push.
- `backend/src/project/agent-status.service.ts` — the per-environment level, the OR across environments and the lifecycle clears.
- `backend/src/project/agent-status-stream.controller.ts` — the user-scoped SSE stream.
- `frontend/src/api/agent-status.ts` — the store and the single EventSource per tab.
- `frontend/src/components/project-card.tsx` — the sidebar spinner.

## Related

- [App Readiness](../projects/app-readiness.md) — the sibling pushed-state feature on the same channel.
- [Service Gateway](../gateways/service-gateway.md) — the channel the pod pushes over.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — the transitions that clear the level.
