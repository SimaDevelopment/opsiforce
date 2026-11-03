---
kind: explanation
terms: [Agent Status, Waiting for input]
adrs: [0020]
---

# Agent Status

> How does the sidebar know a [Project](../../GLOSSARY.md)'s Agent is Working, or that a chat is waiting for its user, without polling, and what keeps those signals from sticking?

## How it works

- [Agent Status](../../GLOSSARY.md) is Working when the Agent is processing a run, provider retries included, and Idle otherwise; it is carried per [ProjectEnvironment](../../GLOSSARY.md) and a Project is Working when any of its environments is.
- The `opsiforce.observer` plugin inside each pod's OpenCode posts `run.started` and `run.ended` for every OpenCode session, root or sub-agent, to `POST /api/gateway/agent/observations` over the [Service Gateway](../gateways/service-gateway.md) channel ([ADR-0020](../adr/0020-agent-status-pushed-and-resynced-not-heartbeated.md)).
- The backend owns, per environment and in memory, the set of running OpenCode session ids, keyed by the environment behind the posting pod's gateway token, so a pod cannot report for another environment; the environment is Working while that set is non-empty, so a background sub-agent keeps it Working after its parent's run has ended.
- `run.started` adds the session to the set and `run.ended` removes it; duplicates change nothing, and any well-formed observation is answered 204, unknown kinds included, so new kinds are additive.
- [Waiting for input](../../GLOSSARY.md) is a second flag per environment, beside Agent Status rather than a third value of it ([ADR-0020](../adr/0020-agent-status-pushed-and-resynced-not-heartbeated.md)): the observer posts `input.requested` with the request id when OpenCode asks a permission (`permission.asked`) or a question (`form.created`), and `input.resolved` when that request is replied to or cancelled. The backend keeps the set of pending request ids and the environment waits while it is non-empty; a waiting run is still Working.
- While an environment is Working or waiting, the backend re-reads the pod's `GET /api/session/active`, `GET /api/permission/request` and `GET /api/form` every 60 seconds and replaces both sets, so a lost request or reply heals within a minute; a pod that does not answer, or is no longer running, turns the environment Idle and waiting for nothing. An environment that is neither is never re-read.
- A Working Agent holds its pod: `run.started`, each re-read that finds the pod still running, and the turn to Idle touch the environment's agent keep-alive key, so its idle timeout counts from when the Agent goes Idle ([Pod Lifecycle](../runtime/pod-lifecycle.md)). Lifecycle clears and Idle environments touch nothing.
- The backend clears both sets at every lifecycle transition it drives (suspend, restart, disable, fail, delete, the pod-recreating [Publish](../projects/publish.md)) and on boot re-reads every active environment's running sessions and pending requests before the HTTP listener starts.
- The projects list and the public API's Project carry `agentStatus` and `waitingForInput`, both read across all of the Project's environments, and the sidebar renders a small spinner with an "Agent working" label while Working.
- Above the project tree the sidebar keeps two sections, each shown only when it has rows: **Waiting for input** lists Projects with a chat waiting for an answer or a permission, shown to every member who sees the Project, and **Working** lists Projects whose Agent is Working and not waiting. Each section header folds, keeps its count while folded, and remembers the fold in the browser. Waiting reads `waitingForInput` from the projects list and the stream's Project-level messages. A waiting row shows a needs-you dot in place of the spinner.
- Broken and disabled Projects are not listed there: a `failed` Project says Failed on its row, and a folded workspace or folder carries a dot for a waiting chat or, failing that, a failed Project inside it. Disabled Projects are found with the Status filter (All, Enabled, Disabled) beside Mine and the activity filter, and a failed run stays on its card in the runs dock.
- Live updates ride the Redis project-events bus into one user-scoped SSE stream per tab: on connect the backend computes the user's visible Projects with the same predicate as the projects list, emits each one's level, then forwards only transitions for those Projects. These are plain `data: {projectId, agentStatus, waitingForInput}` messages, sent when either value changes.
- The same stream carries per-environment events, named `environment`, as `{projectId, environmentId, agentStatus}`: on connect one `working` event for each environment Working at that moment, then one event each time an environment turns Working or Idle. An Idle event follows only a Working event sent on the same connection, and a sub-agent still running keeps its environment from turning Idle.
- It also carries App serving events, named `app`, as `{projectId, environmentId, serving}`: nothing on connect, then one event each time an environment's App starts or stops serving ([App Readiness](../projects/app-readiness.md)), so a `serving: true` event always follows a moment the connection saw the App not serving.
- The frontend seeds a `projectId → agentStatus` store from the projects-list payload on every list load, then applies the stream's Project-level messages to it, and the project row reads it.
- The project page reloads the App preview when the environment it shows goes from Working to Idle, or when its App starts serving, as reported by the stream's environment and app events. A reseed from the projects list never counts as either change, and another environment's event never reloads it.

## Edge cases

- The level lives in the single backend replica's memory, as App readiness does.
- An environment that goes Idle, or whose App starts serving, while a tab's stream is reconnecting sends that tab no event, so its preview does not reload for it.
- A pod whose observer failed to load posts nothing and shows Idle; its turns still work.
- When the observer changes, the change lands only as pods are recreated onto the new image ([Agent Updates](agent-updates.md)).

## Code

- `opencode-plugins/observer/` — the in-pod observer that posts run observations.
- `backend/src/project/agent-observations.service.ts` — the per-kind handling of the observation route.
- `backend/src/project/agent-status.service.ts` — the per-environment sets of running sessions and pending input requests, the re-read while either is non-empty, the OR across environments and the lifecycle clears.
- `backend/src/project/agent-status-stream.controller.ts` — the user-scoped SSE stream.
- `frontend/src/api/agent-status.ts` — the store, the single EventSource per tab and the environment-Idle and App-serving listeners.
- `frontend/src/pages/project.tsx` — the preview reload on the shown environment going Idle or its App starting to serve.

## Related

- [App Readiness](../projects/app-readiness.md) — the sibling pushed-state feature on the same channel.
- [Service Gateway](../gateways/service-gateway.md) — the channel the pod pushes over.
- [Pod Lifecycle](../runtime/pod-lifecycle.md) — the transitions that clear the level.
