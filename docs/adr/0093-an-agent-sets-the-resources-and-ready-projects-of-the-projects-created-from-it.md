# An Agent sets the Resources and Ready Projects of the Projects created from it

An Agent built for heavy work (a data analyst, a non-Node stack) needs every Project of it at Medium or Large without anyone resizing each one, and a Project built on the direct path waits 30 to 60 seconds for its pod at the click.

**A Custom Agent carries Resources and a number of Ready Projects to keep, 0 to 3, for the Projects created from it, stored the way a Project's are: the Resources in `agent_pod_settings`, the mirror of `project_pod_settings` behind `PUT /agents/:id/pod-class`, and the Ready Projects count in `agent_settings.warm_pool_size` beside the Default environment (Agent). Both are part of managing the Agent, so `can_manage_agents` gates them as it gates the rest of a Custom Agent, and an Organization's Ready Projects together are held to its Ready Projects Limit. The UI says Ready Projects and "Keep N ready"; code, the API and the Limit key keep the warm pool name (`warm_pool`, `warmPoolSize`).** Concretely:

- **Resources are copied once, at create.** A new Project's `project_pod_settings` row is the Agent's Resources, whether it is built on the direct path or claimed from a slot; the Project owns it from then on, and a later change to the Agent reaches no existing Project. Project Duplicate keeps the source Project's Resources and Import keeps the bundle's, taking the Agent's only when the bundle carries none.
- **A Ready Project's slot is built at the Agent's Resources**, so a claimed Project's first pod is already the right size. A claim takes only a slot whose numbers match the Agent's current Resources, and the integrity job recycles the rest.
- **A Custom Agent's slots are tenant-less too.** The slot boots the shared `custom` package and receives the Agent's Template, prompt and Skills at the claim, so a Profile edit or Publish never makes a slot stale; the claim then confirms the running OpenCode serves the Agent before handing the Project over. Only the owning Organization can claim one, because only it can start a Project from that Agent.
- **A slot is kept only while the Agent could start a Project:** enabled in its Organization and carrying an Agent Profile at its Default environment (Agent). Otherwise, and above the pool size, the integrity job recycles slots instead of waiting for claims to drain them; deleting the Agent releases its slots first.
- **A copy keeps the source's unless someone chooses otherwise.** Agent Duplicate, Export and Import carry both settings; the Duplicate and Import dialogs show them before anything is written, with Keep or Change, and the request may name other values.
- **The Organization holds a Ready Projects Limit.** `warm_pool` counts the Ready Projects its Custom Agents are set to keep, at a platform value of 3; a save, Duplicate or Import that passes it is refused, and lowering it removes nothing, like every Limit ([ADR-0076](0076-organization-limits-are-key-value-rows-that-follow-the-platform-value-unless-overridden.md)).
- **Custom Agents only.** A Built-in Agent's Resources and pool size come from the image and serve every Organization, so neither is set per Organization.
- **Built-in Agents take both from `agents.json`:** the reconciler mirrors an entry's `poolSize` into the same `agent_settings.warm_pool_size` and its optional `podClass` (a preset; absent or unknown means Small) into `agent_pod_settings` on every boot, so the pool and project create read one place for every Agent. Neither is offered in the UI, because the next boot would overwrite it.
- **No row means Small.** An Agent gets an `agent_pod_settings` row only when its Resources are not Small: set in Settings, carried by a copy, or declared in the registry.

## Considered options

- **Columns on `agents`.** Rejected: `agents` is the Agent's identity and image-mirrored fields; pod sizing has its own table for Projects, and a second shape for the same four numbers would drift.
- **Per Agent Profile, carried by Publish (Agent).** Rejected: size and Ready Projects are operating policy, not the Agent's definition, and a Publish would silently resize or empty the pool.
- **Live inheritance, where the Project reads the Agent's Resources at pod build.** Rejected: an Agent edit would resize every running Project's next pod, breaking the rule that a Project's row fully describes its pod ([ADR-0005](0005-pod-class-project-level-snapshot.md)).
- **Reset the settings on every copy.** Rejected: a copy of a Large Agent would silently run at Small, and nobody would know until a Project ran out of memory.
- **Ready Projects for Built-in Agents per Organization.** Rejected: one Organization's choice would keep pods running that every Organization shares, the per-tenant cost [ADR-0041](0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md) avoids.

## Consequences

- Each Custom Agent can keep up to 3 pods running at its Resources while nobody uses them; the per-Agent cap and the Organization's Ready Projects Limit bound that cost. `POOL_SIZE_OVERRIDE` still caps every Agent.
- While a release that adds this rolls out, backends of the previous release recycle Custom Agent slots they do not recognise as stale, so the pool refills only once every backend runs the new release; `agents.pool_size` stays one release, unread, for those backends.
- Unclaimed slots belong to no Organization, so they never count toward its Projects Limit and appear as the Ready Projects bucket in Unattributed storage; the Organization still sees its Agents' Ready Projects, under their Agent, in the Pods view.
- Nothing on the Public API reads or sets an Agent's Resources or Ready Projects: they cost money while nothing is using them, so only a person who manages Agents changes them, in the UI.
- A claim on a Custom Agent's slot switches the running OpenCode to the Agent through the in-pod control process and waits until `GET /api/agent` lists it; a pod that does not serve it within the Skill confirmation window is torn down and the create falls back to the direct path, so a broken Ready Project costs speed, never a Project on the wrong Agent.
