# App liveness is pushed from the pod over the gateway channel, not polled

The platform needs to know two things about a Project's App at runtime: that it has **gone live** (`app.meta.json` exists, giving the App an identity) and that its process is **serving** on its port. The app pane appears at go-live, and publish, duplicate and schedule all wait for the App to serve. **The pod tells the backend instead of the backend asking.** The in-pod `agent-control` process watches `app.meta.json` and probes `http://127.0.0.1:$APP_PORT/` (any HTTP response counts as serving), and pushes `{serving, live, name, description}` to `POST /gateway/app/state` over the **Service Gateway channel**, authenticated by the environment's `SERVICE_GATEWAY_API_KEY`. `live`, `name` and `description` are set only while the App serves and the file parses.

The backend keeps the two answers apart. Identity from a `live` push is written to that environment's `project_app` row, and a change notifies clients over SSE. `serving` is held only in memory by `AppReadinessService`, whose `awaitReady` is what publish, duplicate and schedule wait on.

The pod is the only party that knows the moment go-live happens. Passive sensing from real traffic cannot bootstrap it: a freshly built Development App has no traffic until its pane is shown, and the pane is gated on the very signal being produced.

## Considered options

- **A hardened backend poll** (single-in-flight, backed off, bounded). Rejected: it still polls an endpoint that is silent for most of an App's pre-go-live life, and still probes the pod IP from outside.
- **Proxy real-path sensing** (the runtime proxy reports the App up or down from the traffic it carries). Rejected as the detection mechanism: it cannot observe a no-traffic Development App. The proxy's failure report exists as a pod **recovery** trigger and never marks the App serving.
- **A fallback for pods whose image predates the push.** Rejected: pods are recreated onto the current image instead of carrying a second code path.

## Consequences

- **Edges, not a heartbeat.** The reporter pushes once at start and then only when its state changes (go-live, serving up, serving down, a new name or description). It probes every 2 s until the App serves and every 15 s after, and reports down only after two failed probes in a row.
- **Delivery is at-least-once.** A push is retried with backoff and, if it still fails, sent again on the next probe; the backend is idempotent, and `upsertProjectApp` skips the write and the SSE when name and description are unchanged. Because `agent-control` evaluates on startup, a go-live that happened while it was down is not missed, and persisted identity survives a backend restart.
- **`awaitReady` wants the next edge.** Every backend-controlled pod-lifecycle boundary (recreate, suspend, disable) calls `markDown`, and deleting a project or environment calls `clear`, so a stale `serving` can never short-circuit a wait and the map cannot grow without bound.
- **A backend restart loses in-flight waiters.** Publish re-runs and schedules fire again, so a fresh pod produces a fresh edge; duplicate recovery resumes against a running pod, so it confirms with a one-shot probe first. With more than one backend replica the in-memory map does not suffice: `serving` would move to Redis with a TTL refreshed by the push, never to a Postgres column, which would report a long-dead pod as serving.
- A pod reachable by its kubelet but **not cross-pod** (a CNI fault) cannot push, so its go-live goes undetected. This is accepted: such a pod also fails the backend's calls to its opencode port, so the chat breaks visibly, and detection self-heals once the network recovers.
- `agent-control` is baked into the agent image, so a change to it reaches a pod only when the pod is recreated onto a new image. A workspace migration marked `requiresPodRecreate` recreates active pods for that purpose.
- The gateway token names a fixed environment, so a pod cannot report state for another Project. App code in the pod could report its own state, a self-only effect already inside the gateway token's trust boundary.
