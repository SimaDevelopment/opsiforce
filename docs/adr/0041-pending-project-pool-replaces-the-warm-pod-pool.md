# Pending project pool replaces the warm pod pool

The warm pod pool kept image-cached pods around and nothing else, so a new Project still ran init containers, seeded a workspace, created a Bifrost team and virtual keys and waited for OpenCode to start, a 30 to 60 second wait at the click. A pending project pool moves all of that ahead of the click: each slot is a complete Project with no tenant (a running pod, a seeded workspace, an orphan Bifrost team with keys, and OpenCode reachable), and creating a Project becomes an atomic claim that rewrites tenant ownership and Bifrost budgets in place. The claim is a few hundred milliseconds instead of a build; the slow path stays as the fallback whenever the pool is empty or a claim fails.

## Considered options

- **Keep the warm pool and speed up init.** Rejected: image pull was never the dominant cost; the Bifrost calls, workspace seed and OpenCode boot were.
- **Pre-create per tenant.** Rejected: slots would sit idle per tenant instead of being shared by all, multiplying idle pod cost.

## Consequences

- Pool rows live in `projects` with `tenant_id = NULL` and `status = 'pending'`, so every listing must exclude them and Unattributed storage counts them as the pool bucket.
- A boot-time integrity job recovers rows stuck in `claiming`, recycles slots whose pod, Bifrost team or baked agent version is broken or stale, and replenishes each agent's pool to its declared size.
- No LLM call happens before a claim, so cost attribution is meaningful from the claim onward.
