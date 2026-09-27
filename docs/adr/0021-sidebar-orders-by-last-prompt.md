# The project sidebar orders by last prompt, not keep-alive activity

The project sidebar lists a user's Projects in recency order. `project_environments.last_active_at` is the Keep-alive activity marker touched on *every* proxied request (the agent surface, VS Code, and DB viewer, plus the deployed App's own traffic), and on file up/download, transcription, pod wake, publish completion, and pool-claim. That column exists to keep pods alive and to drive the Pods view ([ADR-0013](0013-pods-view-reads-live-keepalive-from-redis.md)); sorting by it would reorder the list whenever a Project was merely *touched* — visiting its App, opening its editor — rather than when the user actually worked in it. **A dedicated `projects.last_prompt_at`, stamped only when a user sends a Prompt, orders the sidebar by `COALESCE(last_prompt_at, created_at) DESC`.** `last_active_at` keeps its keep-alive job and is not read for sort.

A Prompt is captured at the one place every user send crosses server-side: the Go agent proxy recognizes `POST` paths matching `^/api/session/[^/]+/prompt$` and fire-and-forgets an internal control-plane call that stamps the Project (resolving env-id → project-id, the resolve `ensure` already performs). The stamp happens on request receipt, does not block the proxied request, and is not throttled — Prompts are naturally seconds-to-minutes apart, unlike the ~1/5s keep-alive touch.

## Why user-send only, the proxy, and a separate column

- **User-send, not "last message."** In interactive use a Prompt and the Agent's reply are seconds apart, so ordering by either yields the same list. The one case they diverge — a long task finishing after the user has moved to another Project — is rare, and capturing "Agent finished" is expensive: it is not a request but a `session.status` transition inside the long-lived `/api/event` SSE stream, requiring a tee-and-parse we judged not worth it. Only the user's send stamps.
- **The proxy, not the frontend.** The Go proxy is the durable system of record for a send regardless of which client made it; no client should be the authority for sort order. Server-side capture also keeps both activity concepts (keep-alive and last-prompt) in one layer.
- **A new column, not a repurposed one.** `last_active_at` must count App traffic and pod wakes to do its keep-alive job — exactly the events sort must ignore. The two concepts cannot share a column without one corrupting the other.

## Consequences

- A Project with no Prompt yet sorts by its `created_at` through the COALESCE.
- Sorting moves from the joined default-environment row to the Project row, so a Prompt in *any* environment reorders the sidebar. The default env is still joined for the `disabled` bucket.
- Duplicate, Import, and pool-claim reset `last_prompt_at` (leave it null) so a freshly obtained Project surfaces at the top by its own `created_at` — the same intent as the pool-claim `created_at` reset.
- The hook is coupled to opencode's `prompt` path name; if opencode renames them the sidebar silently stops updating. Only a user Prompt stamps — creating an empty session or aborting a turn does not.
