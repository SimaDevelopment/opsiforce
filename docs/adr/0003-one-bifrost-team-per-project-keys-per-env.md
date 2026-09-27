# One Bifrost team per project; one virtual-key pair per project

A `Project` gets a single Bifrost team (`bifrostProjectId` on the project) that carries the project-level budget cap, and a single pair of virtual keys (chat + backend) under that team. **Every `ProjectEnvironment` of the project shares that one key pair** — publishing a new environment does not mint new keys; its pod resolves the project's keys. The keys are born with the Development environment (which reuses the project id), so the Development environment's key pair *is* the project's key pair.

Anchoring the budget on the team keeps a project-level cap enforceable: Bifrost has no parent-of-teams to sum a cap across per-environment teams. Sharing one key pair — rather than one pair per environment — keeps the model simple while that cap is the only budget that matters. The cost is that Bifrost's per-key spend no longer attributes usage to a specific environment; all of a project's environments report under the same key.

Per-environment keys (for per-environment usage attribution, and later per-environment budgets) are a deferred, **additive** enhancement: the pod-options resolver already prefers a key row matching the environment and falls back to the project's pair, so reintroducing per-environment keys is just "start inserting per-environment rows again" — no resolver rewrite, no team restructuring.

## Consequences

- Publishing an environment creates no virtual keys; deleting a non-Development environment revokes nothing (it has no key rows); deleting the project revokes the project's key pair and deletes the team.
- Project-level budget and key operations are unambiguous because there is exactly one chat and one backend key per project.
- Usage is not attributable per environment until the deferred per-environment-keys enhancement lands.
