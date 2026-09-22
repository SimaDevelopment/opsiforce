---
kind: explanation
terms: [Connection, Session]
adrs: [0036, 0038]
---

# Connection

> How does a program connect to a ProjectEnvironment's runtime and then talk to its Agent?

## How it works

### Connect first

- The conversation is not a platform resource: a program talks to opencode the way the browser does, through `/api/proxy/{environmentId}`, with opencode's own paths, bodies, responses, defaults and event framing ([ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md)).
- A [Connection](../../CONTEXT.md) is `POST /api/v1/projects/{id}/environments/{environmentId}/connect`: it checks the caller can see the [Project](../../CONTEXT.md) and the environment belongs to it, wakes the environment inside one 30-second budget, resolves and persists the primary [Session](../../CONTEXT.md), reads the build the runtime reports, and answers `baseUrl`, `openapiUrl`, `sessionId` and `build`.
- The Session binding is the remembered Session if it is still a root, else the oldest root, else a new one; only a confirmed 404 from the runtime falls through, only the create step takes the advisory lock, adoption is a conditional update, and nothing is ever deleted. Oldest is the smallest `time.created`, which the platform computes itself after paging the whole root list ([ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md)).
- The URLs are origin-relative and the platform never reads a `Host` header, so the same descriptor works in a hosted, local or standalone deployment.
- Every environment in a Project answers with the same fields under `opencode` from metadata alone, `sessionId` null until a first Connection; no pod is touched.
- The backend's own calls into a pod's opencode port go through the agent-session module, which owns the wake hold, the reload gate, the binding and typed errors ([ADR-0036](../adr/0036-agent-session-is-the-backends-only-door-to-a-pods-opencode-port.md)); consumer traffic goes through the Go proxy, which ensures the environment, stamps prompts and touches activity, and authorizes by asking the backend with the edge's identity ([Request Flows](../runtime/request-flows.md)).

### Then it is opencode

- `wait` means the Session went idle, not that a particular prompt succeeded; the result is read from messages or events.
- The event stream is opencode's, unfiltered and unreframed, with no replay: reconnect and resync from the message list.
- Delivery defaults to opencode's `steer`; a program that means "next turn" asks for `queue` explicitly.
- Reads can wake an environment and touch its activity, because the proxy path ensures the environment on the way in.
- A prompt sent with the caller's own `id` is admitted once: the runtime answers the same body for the same id and conflicts on a different one, so an ambiguous prompt is replayed with the same id and body.
- Reconnecting after a restart or an expired token is connecting again; the Session id is stable, so resynchronising is connect, then read messages from the last id seen.
- Reaching a runtime is environment-level access, including filesystem, shell, session mutation, model switching and integration or credential operations; it is granted the way Project access is.
- `/api/v1/docs` offers a second document, Agent Runtime, served from the spec vendored beside the runtime source with a `servers` variable for the environment; the authoritative document for a running environment is the `openapiUrl` the Connection reports, and the two move together only because [upgrading opencode](../operations/upgrade-opencode.md) moves the image pin and the vendored tree in one change.
- [`example/`](example/) is a runnable consumer that pins the client package against the runtime build, resolves discovery URLs against a known origin, supplies the fetch adapter the generated client needs, and exercises connect, prompt, events, messages, wait and interrupt.

## Edge cases

- When the environment is still starting as the budget runs out, the answer is a 503 `environment-starting` Error with `Retry-After: 5`.
- When the environment is disabled, the answer is 423; when it has failed, 503 `environment-failed`; when the pod is ready but unreachable, 502 or 504.
- When a bearer is missing or expired on the proxy path, oauth2-proxy answers 401; when the environment is starting or restarting there, the proxy answers 503 with `Retry-After: 5`.
- When the agent image moves to a new opencode build, consumers see the new protocol directly ([Upgrade opencode](../operations/upgrade-opencode.md)).
- When the root list does not end within a hundred pages, the Connection fails instead of binding from a partial scan.

## Code

- `backend/src/public-api/projects/` — the connect route and the discovery fields on the Project DTO.
- `backend/src/agent-session/` — the connection service, Session binding, wake hold and typed errors.
- `proxy/internal/server/` — the runtime path: ensure, prompt stamping, activity, authorization.
- `backend/src/public-api/public-api.docs.ts` — the docs page and the Agent Runtime document.
- `frontend/opencode/` — vendored, never edited; the spec snapshot the docs page serves.

## Related

- [API Token](api-token.md) — signing in before connecting.
- [Public API contract](contract.md) — Errors and the compatibility policy for the platform half.
- [Request Flows](../runtime/request-flows.md) — the proxy path a program shares with the browser.
- [Persistence](../runtime/persistence.md) — why the Session survives a pod swap.
- [Upgrade opencode](../operations/upgrade-opencode.md) — the runbook for a new runtime build.
