# The public chat API is a pinned subset facade over the environment's primary Session

Status: superseded (2026-09-11) by [ADR-0038](0038-chat-is-native-opencode-through-the-runtime-proxy.md) — the facade shipped on `feature/public-api` and was removed before release

> **Superseded.** The requirement that followed this decision was to chat with a Project through *the same API opencode has*, with opencode's own client — which this ADR's explicit non-goal ("`@opencode-ai/sdk` compatibility is not a goal") rules out. Chat is now native opencode through the runtime proxy; the platform keeps access, provisioning, lifecycle and the connection operation. The rationale below is kept because it records what the facade bought and what dropping it costs.

Programs (a CLI, an integration, another Agent) need to prompt a Project's Agent and read the conversation back. The conversation lives in opencode inside the pod, whose HTTP API is large, session-addressed, unversioned and changes with every upstream snapshot. Exposing it directly would tie every consumer to opencode's release train and leak the pod's filesystem view; rewriting it as our own chat model would cost a second contract to keep in step with the UI, which speaks opencode's shapes already.

The public API therefore exposes six chat routes under `/api/v1/projects/{id}/session` — get the Session, prompt, list messages, wait, interrupt, event stream — whose paths are opencode's minus the session id and whose bodies and responses are **copied from the vendored opencode spec at the current snapshot and frozen**. The session id is dropped because a caller never creates or picks a Session: every ProjectEnvironment carries exactly one primary Session, resolved server-side (the remembered id if it is still a root session, else the oldest root, else created) and written back to the environment. The copy is hand-authored zod, seeded once from `frontend/opencode/packages/protocol/openapi.json` and then owned by us; an adapter (`agent-session`, ADR-0036, plus a mapper in `public-api/session`) absorbs upstream changes. Unknown future message variants and event kinds are dropped, never mapped to a placeholder, so the closed output schemas never lie. Not a pass-through, not a rewrite, and `@opencode-ai/sdk` compatibility is not a goal.

Semantics the copy alone does not carry, settled against a live pod:

- A prompt wakes a sleeping environment and holds up to 30 s for it (measured cold wake: 9 s). Read routes never wake; they answer with an Error (`environment-starting`, `environment-disabled`, `environment-failed`) instead.
- The public prompt body is opencode's minus `files` and `resume`. `delivery` defaults to `queue` (opencode's default is `steer`): a script means "next turn", a human typing means "fold it in". Concurrent prompts are reported through the copied inbox entry, no invented flag.
- `?wait=true` is additive: the same inbox entry plus an `outcome` block (`succeeded | failed | interrupted | queued | working`, `lastAssistantMessageId` from `step.ended` or `step.failed`, `error` copied verbatim on `failed`), settled from the execution events. `queued` exists because a turn can end before this prompt is delivered; reporting `working` until the timeout would be a lie.
- Public `interrupt` sends `continue=true` and then steers every parked `queue` item so nothing is stranded; `?pending=cancel` cancels them instead. All parked items are touched regardless of origin, because origin is unknowable across replicas and matches what the UI stop button does. The inbox routes themselves stay internal.
- The event stream is re-framed with `id` and `event`, filtered to an allow-list of twenty session kinds for the primary Session, fanned out from one upstream connection per environment per replica, with a heartbeat and a terminal `problem` event on failure. `Last-Event-ID` is accepted and ignored in v1.
- `Session.Info` is the one edited copied shape: `location` (the pod's filesystem view) is stripped, as are `directory`, `projectID`, `workspaceID` and `slug` should they reappear.

## Considered options

- **Pass opencode through** under `/projects/{id}/opencode/*`. Rejected: consumers inherit every upstream break, pod internals leak, and the session id becomes a caller concern although there is only ever one.
- **Design our own chat resource.** Rejected: a second model to keep aligned with the UI, which renders opencode's message variants unchanged; the copy gives the same fidelity for free.
- **Derive the schemas from the vendored spec at build time.** Rejected: the contract must be authored and frozen, not follow the vendored snapshot; a bump would silently republish a changed contract.
- **Default `delivery` to opencode's `steer`.** Rejected: a program's second prompt is a new instruction, not a mid-turn correction.

## Consequences

- An opencode bump is a deliberate event with a runbook ([opencode-bump.md](../public-api/opencode-bump.md)): only the adapter and mapper may change, the public schemas change only by decision.
- New upstream fields, kinds and variants are invisible to API consumers until added on purpose; that is the point, and it is also work.
- Replay after a dropped stream, a public inbox view, and file attachments are known gaps recorded on the map, not accidents.
- The Agent Status badge's dependence on the unpublished `session.status` event is a pre-existing agent-control bug the facade does not paper over.

## Amendments

Recorded when the facade shipped; each is additive to what the decision above describes.

- **`session.usage.updated` joined the event allow-list.** The design named execution, inbox, step, text, tool, retry and rename. Cost and token totals arrive on their own kind, and a consumer that only watches steps never sees the running total, so the kind is forwarded too.
- **The stream frames the design did not name.** Every stream opens with a `server.connected` frame carrying the resolved session id, so a consumer learns which Session it is watching without a second call, and a comment heartbeat every fifteen seconds keeps intermediaries from closing an idle connection. `Last-Event-ID` is accepted and ignored rather than rejected, because rejecting it would break a stock `EventSource`, which sends the header on every reconnect and cannot be told not to.
- **`?wait=true` got an explicit bound.** The hold is `timeoutMs`, one minute by default and five at most, and the wake hold is spent from the same budget. Without a caller-visible bound a wait would inherit whatever the client's own timeout happened to be.
- **The message list published its paging bounds.** Fifty per page by default, two hundred at most, newest first; `order` is rejected together with a cursor, since the cursor already carries the direction it was minted with.
