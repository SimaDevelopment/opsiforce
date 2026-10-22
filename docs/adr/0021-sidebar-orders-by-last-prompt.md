# The project sidebar orders by last prompt, not keep-alive activity

The project sidebar lists a user's Projects in recency order. `project_environments.last_active_at` is the Keep-alive activity marker touched on *every* proxied request (the agent surface, VS Code, and DB viewer, plus the deployed App's own traffic), and on file up/download, transcription, pod wake, publish completion, and pool-claim. That column exists to keep pods alive and to drive the Pods view ([ADR-0013](0013-pods-view-reads-live-keepalive-from-redis.md)); sorting by it would reorder the list whenever a Project was merely *touched* — visiting its App, opening its editor — rather than when the user actually worked in it. **A dedicated `projects.last_prompt_at`, stamped only when a user sends a Prompt, orders the sidebar by `COALESCE(last_prompt_at, created_at) DESC`.** `last_active_at` keeps its keep-alive job and is not read for sort.

A Prompt is captured inside opencode: every user item a session will process passes through that session's inbox, published as `session.inbox.enqueued`. **The `opsiforce.observer` plugin ([ADR-0093](0093-opsiforce-extends-opencode-through-plugins-baked-into-the-agent-image-one-per-risk-class.md)) reports each `user` item that enters an opencode session's inbox, with whether that session is a root, and the backend stamps the Project's `last_prompt_at` when it is.** The stamp is not throttled — Prompts are naturally seconds-to-minutes apart, unlike the ~1/5s keep-alive touch.

- **Only a user's Prompt in a root session stamps.** Sub-agent prompts and opencode's synthetic prompts (such as the continuation after an output-limit cut) never stamp. A request opencode rejects doesn't stamp; a slash command does. Prompts from the browser and from programs through the public API both count, steered and queued alike; opencode publishes exactly one `inbox.enqueued` per Prompt, so one Prompt is one stamp.
- **The rule stays in the backend.** The observer reports the item and whether its session is a root; the backend decides it is a Prompt and stamps it.

## Why user-send only, inside opencode, and a separate column

- **User-send, not "last message."** In interactive use a Prompt and the Agent's reply are seconds apart, so ordering by either yields the same list. The one case they diverge — a long task finishing after the user has moved to another Project — is rare, and a run's end is reported once per opencode session, sub-agents included, so it would need a root-session rule of its own for little gain. Only the user's send stamps.
- **Inside opencode, not a client.** opencode's inbox sees every Prompt regardless of which client sent it; no client should be the authority for sort order.
- **A new column, not a repurposed one.** `last_active_at` must count App traffic and pod wakes to do its keep-alive job — exactly the events sort must ignore. The two concepts cannot share a column without one corrupting the other.

## Consequences

- A Project with no Prompt yet sorts by its `created_at` through the COALESCE.
- Sorting moves from the joined default-environment row to the Project row, so a Prompt in *any* environment reorders the sidebar. The default env is still joined for the `disabled` bucket.
- Duplicate, Import, and pool-claim reset `last_prompt_at` (leave it null) so a freshly obtained Project surfaces at the top by its own `created_at` — the same intent as the pool-claim `created_at` reset.
- Only a user Prompt stamps — creating an empty session or aborting a turn does not.
- A pod whose observer failed to load stamps no Prompts, and its Projects keep their place in the sidebar until it is recreated.
- Readers — the sidebar order, the public API's `lastPromptAt` and the Builder chat's "not started" state — read `last_prompt_at` only.
