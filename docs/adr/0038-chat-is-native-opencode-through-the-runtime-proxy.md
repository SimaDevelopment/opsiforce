# Chat is native opencode through the runtime proxy; the platform owns access, provisioning, lifecycle and connection

Status: accepted (2026-09-11) — supersedes [ADR-0033](0033-public-chat-api-is-a-pinned-subset-facade-over-the-primary-session.md)

ADR-0033 answered "how does a program talk to a Project's Agent?" with a pinned facade: six routes under `/api/v1/projects/{id}/session`, bodies copied from the vendored opencode spec and frozen, an event hub re-framing a filtered allow-list, a per-prompt outcome watcher and an interrupt sweep. It shipped, and it works. It also made "SDK compatibility is not a goal" an explicit non-goal — and the requirement that arrived next was to chat with a Project *through the same API opencode has*, with opencode's own client. Those cannot both hold.

**Chat is no longer re-implemented in the backend.** A program reaches opencode exactly the way the browser already does, through `/api/proxy/{environmentId}` — oauth2-proxy, nginx, the Go runtime proxy, agent-control, opencode — with native paths, bodies, responses, defaults and SSE framing. The platform keeps what only the platform can know: `me`, the Agent registry, Project list/get/create/delete, and the binding between a ProjectEnvironment and its primary Session.

What the platform adds to make that a supported surface rather than a leak:

- **A connection operation.** `POST /api/v1/projects/{id}/environments/{environmentId}/connect`, and the internal route the app calls, run one implementation. It authorizes Project visibility and environment ownership, wakes the environment within one 30-second budget, resolves and persists the primary Session, reads the build the ready runtime reports, and answers 200 only when all of that holds. A caller no longer re-implements "list roots, pick the oldest, else create".
- **Origin-relative discovery.** Every environment in the Project DTO carries `opencode: { baseUrl, openapiUrl, sessionId }`. A consumer resolves those against the origin it already called the platform on, so there is no new public-origin setting and no trust placed in a caller-supplied `Host`. `sessionId` is the remembered binding — discovery information, not a readiness guarantee.
- **Authorization parity on the runtime path.** The proxy's ensure call forwards the edge's trusted identity headers, and the backend gates the agent surface by Organization membership *and* the same per-user Project visibility predicate the Project list uses. The Go ready-cache is partitioned by user, not by groups alone.

## Considered options

- **Keep the facade beside the native path.** Rejected: two transports for one conversation, both needing the semantics kept in step, and no deployed consumer that requires a migration path.
- **Publish a platform-owned chat schema that tracks opencode.** Rejected: that is the facade, and it is exactly what makes the runtime's own client unusable.
- **Return an absolute `baseUrl`.** Rejected: it needs either a configured public origin per deployment or the caller's `Host` header, which is untrusted.
- **Persist the runtime build on the environment.** Rejected: a stamp written at connection time is last-known information, and keeping it honest across restart, reload and rollout is an invalidation system nobody asked for. Build is read from the ready runtime during a connection and reported there only.
- **Delete the loser of a binding race.** Rejected on a counterexample: A creates S1, B discovers and binds S1, A loses the compare-and-set and deletes the Session B is now using. Speculative deletion is never correct here, because a Session we did not bind may already be another user's. The compare-and-set itself is kept — it is how the binding converges without a lock; only the deletion is rejected. Nothing in the connection path calls `deleteSession`.
- **Hold the advisory lock across the whole resolve/create/persist sequence.** Rejected after measuring: it puts a database lock around two or three network calls to a pod on every connection, and the two common paths — the remembered Session is still a root, or an existing root is adopted — race harmlessly. See the serialization decision below.

## How the primary Session is bound

The binding rule is the one the browser already applied, moved into the backend unchanged: **the remembered Session if it is still a root, else the oldest root, else create one.** Keeping it identical is what makes the change safe for Projects that already exist — a Project whose binding was never persisted resolves to exactly the Session the app would have picked, so no conversation is orphaned. Only a *confirmed* absence (a 404 from the runtime) allows falling through; a timeout or an unreachable pod is an error, because treating it as "the Session is gone" would silently strand someone's history behind a new one.

Only the last step needs serializing, and the three paths pay different prices:

- **Remembered Session is still a root** — two reads, no lock, no write, no transaction. The overwhelmingly common case.
- **An existing root is adopted** — claimed with a conditional `UPDATE … WHERE session_id` matching what this connection observed. If it updates no rows another connection won the race, so this one re-reads and uses the winner's Session. No lock: the database arbitrates, and both callers converge on the same existing Session.
- **No root exists** — the only irreversible upstream act, and the only path that takes the transaction-scoped advisory lock keyed by environment id. It happens about once in an environment's lifetime. Inside the lock the binding is re-read, so a caller that waited adopts what the winner created instead of creating a second Session.

The lock deliberately does **not** wrap the whole sequence. That would put a database lock around two or three network calls to a pod on every single connection; measured, a connection is ~40 ms, so the contention window it protects is tiny while the cost is paid every time. It also does not make PostgreSQL and opencode atomic: a crash between creating a Session upstream and persisting the binding leaves an unbound root, which the next connection adopts by the same rule. That is why nothing is ever deleted.

Session ids are descending-encoded, so a newer Session sorts lower as a string. "Oldest root" means `order=asc&limit=1` by creation time — deriving it from the id would pick the newest and orphan the history.

## Consequences — the losses, accepted deliberately

- **No platform-owned chat schema stability.** The conversation is the protocol of the deployed build. A bump can change bodies, kinds and defaults, and the platform will not absorb that for consumers.
- **No per-prompt outcome.** Native `wait` means the Session went idle, not that a particular prompt succeeded. Consumers read the outcome from messages or events.
- **Native `steer` is the delivery default again.** The facade defaulted to `queue` for programs; native opencode does not.
- **No interrupt sweep.** Native interrupt stops the turn; parked inbox items are the caller's business.
- **Events are unfiltered and unreframed.** No allow-list, no `server.connected` frame, no heartbeat, no terminal `problem` event — opencode's stream as it is.
- **Runtime reads can wake an environment and touch its activity**, because ensure runs on the proxied path. The facade's read routes deliberately never woke a pod.
- **Errors come from two places.** `/api/v1` answers platform Errors; `/api/proxy` answers native opencode errors and the edge's or proxy's own failures.
- **Runtime access is environment-level.** It includes filesystem and shell operations, session mutation, model switching and integration or credential operations — not prompt-only access. There is no spoofable user/program marker; a narrowly scoped service-account credential is separate work.

## Consequences — what improves

- The verified opencode client works against a Project, with a documented fetch adapter for the upstream root-relative URL bug (anomalyco/opencode#46498).
- One connection operation serves both the app and programs, so the browser and a program bind the same Session by construction.
- Roughly two thousand lines of copied schema, event hub, outcome watcher and sweep stop needing an owner at every bump.
