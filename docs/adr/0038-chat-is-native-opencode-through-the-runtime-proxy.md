# Chat is native opencode through the runtime proxy; the platform owns access, provisioning, lifecycle and connection

Programs (a CLI, an integration, another Agent) need to prompt a Project's Agent and read the conversation back, with opencode's own client and the same API opencode has. The conversation lives in opencode inside the pod.

**Chat is not re-implemented in the backend.** A program reaches opencode exactly the way the browser already does, through `/api/proxy/{environmentId}` — oauth2-proxy, nginx, the Go runtime proxy, agent-control, opencode — with native paths, bodies, responses, defaults and SSE framing. The platform keeps what only the platform can know: `me`, Agents, Skills, Projects, and the binding between a ProjectEnvironment and its primary Session.

What the platform adds to make that a supported surface rather than a leak:

- **A connection operation.** `POST /api/v1/projects/{id}/environments/{environmentId}/connect`, and the internal route the app calls, run one implementation. It authorizes Project visibility and environment ownership, wakes the environment within one 30-second budget, resolves and persists the primary Session, reads the build the ready runtime reports, and answers 200 only when all of that holds. A caller never re-implements "list roots, pick the oldest, else create".
- **Origin-relative discovery.** Every environment in the Project DTO carries `opencode: { baseUrl, openapiUrl, sessionId }`. A consumer resolves those against the origin it already called the platform on, so there is no public-origin setting and no trust placed in a caller-supplied `Host`. `sessionId` is the remembered binding — discovery information, not a readiness guarantee.
- **Authorization parity on the runtime path.** The proxy's ensure call forwards the edge's trusted identity headers, or a pod's `gw-` bearer ([ADR-0062](0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)), and the backend gates the agent surface by Organization membership *and* the same per-user Project visibility predicate the Project list uses. The Go ready-cache is keyed by that identity, not by groups alone.

## Considered options

- **Design our own chat resource.** Rejected: a second model to keep aligned with the UI, which renders opencode's message variants unchanged, and it makes the runtime's own client unusable.
- **Return an absolute `baseUrl`.** Rejected: it needs either a configured public origin per deployment or the caller's `Host` header, which is untrusted.
- **Persist the runtime build on the environment.** Rejected: a stamp written at connection time is last-known information, and keeping it honest across restart, reload and rollout is an invalidation system nobody asked for. Build is read from the ready runtime during a connection and reported there only.
- **Delete the loser of a binding race.** Rejected on a counterexample: A creates S1, B discovers and binds S1, A loses the compare-and-set and deletes the Session B is now using. Speculative deletion is never correct here, because a Session we did not bind may already be another user's. The compare-and-set itself is kept — it is how the binding converges without a lock; only the deletion is rejected. Nothing in the connection path calls `deleteSession`.
- **Hold the advisory lock across the whole resolve/create/persist sequence.** Rejected after measuring: it puts a database lock around two or three network calls to a pod on every connection, and the two common paths — the remembered Session is still a root, or an existing root is adopted — race harmlessly. See the serialization decision below.

## How the primary Session is bound

**The remembered Session if it is still a root, else the oldest root, else create one.** A Project whose binding was never persisted resolves to the Session a browser would have picked, so no conversation is orphaned. An adopted Session that carries no agent is re-pointed at the Project's Agent. Only a *confirmed* absence (a 404 from the runtime) allows falling through; a timeout or an unreachable pod is an error, because treating it as "the Session is gone" would silently strand someone's history behind a new one.

Only the last step needs serializing, and the three paths pay different prices:

- **Remembered Session is still a root** — two reads, no lock, no write, no transaction. The overwhelmingly common case.
- **An existing root is adopted** — claimed with a conditional `UPDATE … WHERE session_id` matching what this connection observed. If it updates no rows another connection won the race, so this one re-reads and uses the winner's Session. No lock: the database arbitrates, and both callers converge on the same existing Session.
- **No root exists** — the only irreversible upstream act, and the only path that takes the transaction-scoped advisory lock keyed by environment id. It happens about once in an environment's lifetime. Inside the lock the binding is re-read, so a caller that waited adopts what the winner created instead of creating a second Session.

The lock deliberately does **not** wrap the whole sequence. That would put a database lock around two or three network calls to a pod on every single connection; the contention window it protects is tiny while the cost is paid every time. It also does not make PostgreSQL and opencode atomic: a crash between creating a Session upstream and persisting the binding leaves an unbound root, which the next connection adopts by the same rule. That is why nothing is ever deleted.

Session ids are descending-encoded, so a newer Session sorts lower as a string. "Oldest root" means the smallest `time.created`, and the platform computes it itself after paging through every root: opencode's list endpoint orders only by `time.updated`, so `order=asc&limit=1` returns the root nobody has touched for the longest time — on a pod with test residue that is an abandoned empty Session, not the conversation. Deriving it from the id would pick the newest and orphan the history.

## Consequences — accepted costs

- **No platform-owned chat schema stability.** The conversation is the protocol of the deployed build. A bump can change bodies, kinds and defaults, and the platform will not absorb that for consumers.
- **No per-prompt outcome.** Native `wait` means the Session went idle, not that a particular prompt succeeded. Consumers read the outcome from messages or events.
- **The delivery default is native `steer`.** A program that wants its second prompt to wait for the next turn sends `queue` itself.
- **Interrupt is native.** It stops the turn; parked inbox items are the caller's business.
- **Events are opencode's stream as it is**, unfiltered and not re-framed.
- **Runtime reads can wake an environment and touch its activity**, because ensure runs on the proxied path.
- **Errors come from two places.** `/api/v1` answers platform Errors; `/api/proxy` answers native opencode errors and the edge's or proxy's own failures.
- **Runtime access is environment-level.** It includes filesystem and shell operations, session mutation, model switching and integration or credential operations — not prompt-only access. There is no spoofable user/program marker.

## Consequences — what improves

- The verified opencode client works against a Project, with a documented fetch adapter for the upstream root-relative URL bug (anomalyco/opencode#46498).
- One connection operation serves both the app and programs, so the browser and a program bind the same Session by construction.
