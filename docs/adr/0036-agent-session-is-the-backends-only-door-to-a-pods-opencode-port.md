# `agent-session` is the backend's only door to a pod's opencode port; the Go proxy reports facts and never decides

Status: accepted (2026-09-10), amended 2026-09-11 by [ADR-0038](0038-chat-is-native-opencode-through-the-runtime-proxy.md)

> **Amendment (2026-09-11).** The rule now reads: `agent-session` is **the backend's only door for the backend's own calls** to a pod's opencode port. Browser and program chat go through the Go proxy by design — that is ADR-0038, not an exception to this one. What stays here is lifecycle, probes and connection binding: `ensureAgentSurface` with the reload gate, `wakeForConnection` with the wake hold, `activeSessions`, and the connection operation that resolves and persists the primary Session. The `AgentSession` handle, `openForPrompt`/`openForRead`, the event hub, the activity throttle and the prompt stamp are gone from this module: the Go proxy already stamps prompts and touches activity for the traffic it carries, and `PodOpencodeClient` has shrunk to the calls a connection and a probe need. `PodFailureReporter` is gone too — its one surviving caller is the connection service, which reports a pod failure itself.

Before the public API, the backend touched opencode in a pod from three places with three behaviours: agent-status probed `session/active` with a 3 s timeout and retries, agent-update probed the same route with no timeout and a `?directory=` the server ignores, and the browser's chat reached the pod through the Go proxy, which alone knew the wake hold, the activity touch, the last-prompt stamp, the pending agent reload and the failure report. The public chat routes would have been a fourth caller reimplementing the proxy's side effects in TypeScript, and any later change to pod-side behaviour would have four homes.

One backend module, **`backend/src/agent-session/`**, is now the only door from the backend to a pod's opencode port. It knows nothing about the public API and throws four typed errors, never Nest exceptions: `EnvironmentNotRunning` (with the state), `PodUnreachable`, `PodTimeout`, `PodResponded`. Callers map them by `instanceof` to their own idiom (Errors, retry, defer). Its handle interface is per environment: `openForPrompt` (ensure, wake hold up to 30 s, the pending agent reload gate copied from the proxy controller, primary Session resolution with write-back), `openForRead` (never wakes, no reload gate), `activeSessions` (the session-free probe for agent-status and agent-update, 3 s timeout, no `directory`), and an `AgentSession` bound to environment, upstream and primary session id with `prompt`, `messages`, `wait`, `interrupt`, `info` and `events`. Activity touch and prompt stamp happen inside those methods; the activity write is throttled to once per environment per 5 s, matching the Go proxy's 5 s ready cache without a stale-readiness window, while ensure itself is evaluated on every call. `PrimarySessionResolver` and the in-memory `EnvironmentEventHub` live inside the module; `PodOpencodeClient` is private and exercised by a fake opencode in tests, not swappable.

The rule this fixes: **new pod-side behaviour goes into `agent-session` or `ProjectService` only.** The Go proxy and `proxy.controller.ts` report facts (this environment, this is a prompt send, this socket is open) and never decide. Transport stays split, the browser through the Go proxy and the backend direct to the pod, because routing the backend through the proxy would loop back into the backend's own ensure route, forge forwarded headers and lose the wake hold. What is shared is the behaviour, not the bytes. The proxy controller's agent ensure delegates to the module, and both `session/active` probes migrate onto `activeSessions` in this effort.

## Considered options

- **Keep the gateway inside `public-api/session`.** Rejected: a health probe going through a "public API" module is wrong on its face, and the migration of internal callers would create a dependency on the public tree.
- **Route the backend through the Go proxy like the browser.** Rejected: the proxy's first act is calling the backend's ensure route (a loop), it trusts forwarded group headers the backend would have to forge, and it has no 30 s wake hold.
- **An injectable opencode client interface.** Rejected: one adapter is a hypothetical seam; the `node:http` fake exercises the real client.
- **An ensure cache like the Go proxy's.** Rejected: ensure on an active environment reads the informer snapshot for free; only the activity write costs, so throttle that.
- **Fold the proxy controller into the module.** Rejected by the deletion test: it is a pass-through and removing it removes no logic.

## Consequences

- Public prompts and browser prompts get the same wake, reload, stamp and failure behaviour by construction.
- The failure report is belt-and-braces: the pod informer's delete event is the primary recovery path when a pod dies under an open stream.
- Agent status could later subscribe to the hub's execution events instead of polling `session/active` (map fog).
- An opencode bump has one place to re-check for paths and one runbook ([opencode-bump.md](../operations/upgrade-opencode.md)).
