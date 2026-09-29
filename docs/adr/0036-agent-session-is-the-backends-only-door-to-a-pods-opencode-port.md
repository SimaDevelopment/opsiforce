# `agent-session` is the backend's only door to a pod's opencode port; the Go proxy reports facts and never decides

The backend calls opencode inside a pod for its own reasons: status probes, update gating, binding the primary Session, confirming a skill delivery. Each caller once carried its own timeout, retry and path quirks, and any change to pod-side behaviour had several homes. Browser and program chat reach the pod through the Go proxy by design ([ADR-0038](0038-chat-is-native-opencode-through-the-runtime-proxy.md)); this ADR covers the backend's own calls.

**Every backend call to a pod's opencode port goes through `backend/src/agent-session/`.** The module knows nothing about the public API and throws four typed errors, never Nest exceptions: `EnvironmentNotRunning` (with the state), `PodUnreachable`, `PodTimeout`, `PodResponded`. Callers map them by `instanceof` to their own idiom (Errors, retry, defer). It holds:

- `AgentSessionGateway`: `ensureAgentSurface` (ensure plus the pending agent reload gate, which the proxy controller's agent ensure delegates to), `wakeForConnection` (the wake hold within one deadline, then the reload gate), and `activeSessions` (the session-free `GET /api/session/active` probe that agent-status and agent-update use, 3 s timeout).
- `AgentConnectionService`: the connection operation, which wakes the environment, resolves and persists the primary Session, reads the build the ready runtime reports, and reports a pod failure itself.
- `PodOpencodeClient`: the one HTTP client for the port, with only the calls a connection, a probe and a delivery confirm need. The delivery module uses it to read `GET /api/skill` after a skill fan-out. It is exercised by a fake opencode in tests, not swappable.

The rule: **new pod-side behaviour goes into `agent-session` or `ProjectService` only.** The Go proxy and `proxy.controller.ts` report facts (this environment, this is a prompt send, this socket is open) and never decide. The Go proxy stamps prompts and touches activity for the traffic it carries. Transport stays split, the browser through the Go proxy and the backend direct to the pod, because routing the backend through the proxy would loop back into the backend's own ensure route, forge forwarded headers and lose the wake hold. What is shared is the behaviour, not the bytes.

## Considered options

- **Keep the door inside `public-api`.** Rejected: a health probe going through a "public API" module is wrong on its face, and internal callers would depend on the public tree.
- **Route the backend through the Go proxy like the browser.** Rejected: the proxy's first act is calling the backend's ensure route (a loop), it trusts forwarded group headers the backend would have to forge, and it has no wake hold.
- **An injectable opencode client interface.** Rejected: one adapter is a hypothetical seam; the `node:http` fake exercises the real client.
- **An ensure cache like the Go proxy's.** Rejected: ensure on an active environment reads the informer snapshot for free.
- **Fold the proxy controller into the module.** Rejected by the deletion test: it is a pass-through and removing it removes no logic.

## Consequences

- The app's connection and a program's connection get the same wake, reload gate and primary-Session binding by construction.
- The failure report is belt-and-braces: the pod informer's delete event is the primary recovery path when a pod dies.
- An opencode bump has one place to re-check for paths and one runbook ([upgrade-opencode.md](../operations/upgrade-opencode.md)).
