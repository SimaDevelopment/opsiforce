# Built-in and Custom Agents share one agents table, told apart by origin

Built-in Agents come from the image's registry and Custom Agents are authored in an Organization, and the picker, Project creation, the pool and the public API read both from one table. That works only if the reconciler never touches an authored row and a registry change never strands a Project.

**Both kinds are rows in `agents`, told apart by `origin` (`built_in` | `custom`); uniqueness, reconciliation and picker liveness are each decided per origin.**

- **Slugs are unique per origin's scope.** A Built-in Agent is a global row (`tenant_id` NULL) and its slug is unique among global rows. A Custom Agent always has a `tenant_id` and a `created_by`, enforced by a CHECK, and its slug is unique within its Organization. A later release shipping a built-in slug an Organization already uses inserts a second row beside the Organization's, and neither identity absorbs the other.
- **The reconciler writes only global rows.** On every boot it upserts each merged-registry entry against the global unique index, stamping `origin`, `version`, `model`, `variant` and `pool_size`. It never deletes a row and never touches a Custom Agent's row. Existing Projects resolve their Agent by id whatever the registry says, so dropping an Agent from a release, or rolling that back, leaves every row and Project intact.
- **Picker liveness is one predicate, stated here.** The Agent picker, Project creation and the public API's Agent listing use the same filter. A Built-in Agent is offered while its slug is in the merged registry. A Custom Agent is offered when its `visibility` lets the caller see it ([ADR-0057](0057-authored-skills-and-agents-are-private-or-public-within-one-organization.md)) and it has an Agent Profile at its Default environment (Agent) ([ADR-0058](0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)). Either kind is offered only while it is not disabled in the caller's Organization ([ADR-0070](0070-skills-and-agents-are-disabled-per-organization-like-projects.md)). The Skill & Agent Builder is never offered; only a Builder chat is created on it.
- **`pool_size` is one column on `agents`.** The reconciler copies each registry entry's `poolSize` on every boot, so the registry stays authoritative for Built-in Agents. A Custom Agent's row holds 0, and the pool warms only built-in rows, so a Custom Agent's Project always takes the ordinary create path.
- **Everything image-owned resolves a Custom Agent to the `custom` package.** The pod boots that package and the Agent Updates sweep compares against the image's version for it ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)). A Custom Agent never enters `agents.json`.
- **Slug reservation does not leak private names.** Creating a Custom Agent is refused when its slug is in the merged registry (public and private entries, checked server-side) or already used in the Organization, and both refusals return the same `name_unavailable` error. A standalone build merges only public entries, so a slug private to SaaS is free there; that Agent never ships there.

## Considered options

- **Platform-wins shadowing on a slug collision.** Rejected: an Agent row is an identity Projects reference, not content to shadow.
- **The reconciler marks registry-absent built-in rows as retired.** Rejected: it needs an undo path for rollbacks and copies a fact the registry already holds; read-time membership is the same fact with no second copy.
- **Reading pool sizes from the registry for built-ins and from the column for Custom Agents.** Rejected: two read paths for one concept.
- **Seeding pool sizes once from the registry and letting the column win afterwards.** Rejected: it turns built-in pool sizing from a code rollout into a runtime knob, against [ADR-0008](0008-agent-model-owned-by-agent-config.md).
- **Letting an Organization set a pool size on its own Custom Agent.** Rejected: it would make creating an Agent a free lever on cluster capacity, holding idle pods for one Organization.
- **Giving each Custom Agent its own presence in the image.** Rejected: the backend writes a Custom Agent's content into its Projects, so one `custom` package serves them all.

## Consequences

- An Organization can see two Agents with the same slug, its own and a later-shipped built-in. Lookups by slug prefer the built-in row.
- A Built-in Agent leaves the picker the moment the registry drops it, while its row and every Project on it stay intact.
