# New Projects are claimed from a pool of pending Projects

Creating a Project from scratch runs init containers, seeds a workspace, creates a Bifrost team and virtual keys and waits for OpenCode to start, a 30 to 60 second wait at the click. **A pending project pool moves all of that ahead of the click:** each slot is a complete Project with no tenant (a running pod, a seeded workspace, an orphan Bifrost team with keys, and OpenCode reachable), and creating a Project becomes an atomic claim that rewrites tenant ownership and Bifrost budgets in place. The claim is a few hundred milliseconds instead of a build; the slow path stays as the fallback whenever the pool is empty or a claim fails.

## Considered options

- **Pre-create per tenant.** Rejected: slots would sit idle per tenant instead of being shared by all, multiplying idle pod cost.

## Consequences

- Pool rows live in `projects` with `tenant_id = NULL` and `status = 'pending'`, so every listing must exclude them and Unattributed storage counts them as the pool bucket.
- An integrity job, at boot and on an interval, recovers rows stuck in `claiming`, recycles slots whose pod is missing, terminating, failing its image pull or not ready after a grace period, or whose workspace is behind the agent's version, and replenishes each agent's pool to its declared size.
- No LLM call happens before a claim, so cost attribution is meaningful from the claim onward.
