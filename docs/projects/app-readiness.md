---
kind: explanation
terms: [Go-live]
adrs: [0015]
---

# App Readiness

> How does the platform learn that an App has gone live and is serving, and who waits on that signal?

## How it works

- Two facts are tracked per [ProjectEnvironment](../../CONTEXT.md): [Go-live](../../CONTEXT.md), the App first existing and running, and serving, the App's process answering right now.
- The pod reports and the backend listens; nothing polls ([ADR-0015](../adr/0015-app-liveness-pushed-not-polled.md)). agent-control watches `app.meta.json` with inotify, probes `$APP_PORT` at the pod's own loopback, and pushes one idempotent `{serving, live, name, description}` event over the Service Gateway channel whenever that state changes.
- The probe requires no route: **any** HTTP answer on `$APP_PORT`, at any status, is serving, so an App in any stack satisfies it ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)). `GET /api/app-meta` stays in the App Builder template for its own tab title and is no longer part of the platform path ([ADR-0010](../adr/0010-app-identity-read-at-runtime.md)).
- `live` means serving **and** `app.meta.json` present; agent-control reads `name` and `description` out of the file it already watches, not out of a response body. The push reuses the pod's gateway token, so the backend resolves the environment from the caller ([Service Gateway](../gateways/service-gateway.md)).
- The backend's readiness service is the single owner of per-environment app state: it records identity into the App row ([App](app.md)), notifies the open workspace over SSE so the app pane appears, and resolves `awaitReady` for whatever [Publish](publish.md), [Duplication](duplication.md) or [Schedule](schedule.md) run is waiting.
- Delivery is at least once: agent-control retries until acknowledged and resyncs at startup; identity persists in the App row, so a backend restart loses no detection.
- Pushes happen only on edges (Go-live, serving up, serving down), never on a timer; every `awaitReady` consumer recreates or wakes the pod and marks `serving` down first, so it always waits for the next edge on a fresh pod ([ADR-0015](../adr/0015-app-liveness-pushed-not-polled.md)).
- Identity is durable in the App row while `serving` is an in-memory edge the backend marks down at every pod boundary it controls (pod create, idle suspend, project disable) and clears on delete.
- The runtime proxy's failure report is a separate path: it inspects pod state and recovers the pod from real traffic and never writes `serving` ([Request Flows](../runtime/request-flows.md)).

```
AGENT POD                                   BACKEND
┌────────────────────────────┐           ┌───────────────────────────┐
│ app — serves on its port    │  push     │ gateway token → {project,  │
│ agent-control               │  state    │   environment}             │
│  • inotify(app.meta.json)   ├──────────►│ readiness service          │
│  • probe(localhost app port)│  on edges │  • per-env app state       │
│                             │           │  • awaitReady(env)         │
└────────────────────────────┘           │  → App row · SSE to UI     │
                                          └───────────────────────────┘
consumers of awaitReady: publish · duplicate · schedule
```

## Edge cases

- When a pod is reachable by its kubelet but not by the cluster, the platform never learns the App is down; this gap is accepted.
- When `app.meta.json` is written by the backend (a human edit), the in-pod watch does not fire; the edit path updates the App row and SSE directly, so the watch only ever needs the agent's in-pod write.
- When the App is a multi-process stack, the first process to answer on `$APP_PORT` makes it serving — for the App Builder template that is Vite, seconds before NestJS finishes booting — so Publish can report ready slightly early and a backend-only crash is not visible as *serving down*; this gap is accepted ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- When the agent-control binary changes, the feature lands only as pods are recreated onto the new image, delivered by an agent-update migration that requires pod recreation ([Agent Updates](../agent-system/agent-updates.md)).

## Code

- `proxy/cmd/agent-control/reporter.go` — the in-pod watch, probe and push.
- `backend/src/project/app-readiness.service.ts` — per-environment state, `awaitReady`, mark-down at pod boundaries.
- `backend/src/project/app.controller.agent.ts` — the gateway-guarded push endpoint.

## Related

- [App](app.md) — how detected identity becomes per-environment App Details.
- [Service Gateway](../gateways/service-gateway.md) — the channel and token the reporter pushes over.
- [Publish](publish.md) — the `migrating` stage that waits on readiness.
- [Pod Tools](../runtime/pod-tools.md) — agent-control among the pod's processes.
