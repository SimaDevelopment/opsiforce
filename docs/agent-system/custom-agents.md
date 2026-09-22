---
kind: explanation
terms: [Custom Agent, Built-in Agent, Agent Profile, Publish (Agent), Default environment (Agent), Archive (Agent), Duplicate (Custom Agent)]
adrs: [0054, 0057, 0058]
---

# Custom Agents

> How an Agent authored in the platform is defined per Environment, published, made visible and retired?

## How it works

### Two kinds, one table

- A [Built-in Agent](../../CONTEXT.md) is a global row reconciled from the image registry; a [Custom Agent](../../CONTEXT.md) is a row owned by one Organization. They share the `agents` table and are told apart by `origin` and by whether `tenant_id` is set, so one slug may name a Built-in Agent globally and a different Organization's own Agent at the same time without collision ([ADR-0054](../adr/0054-built-in-and-custom-agents-coexist-by-scope.md)).
- A Custom Agent carries no template and no workspace migrations. Its Projects boot the image's shared `custom` package and start from an empty workspace, so whatever the App becomes is what its instructions told the agent to build.
- Only the fields an author writes are the Agent's own: display name, description, prompt body, [Agent Model](../../CONTEXT.md) pair and [Agent Skills](skills.md). Everything else — tools, permissions, the platform facts — belongs to the pod and to the [Platform Skill](platform-skill.md).

### One definition per Environment

- An [Agent Profile](../../CONTEXT.md) is the Agent's definition in one scope. A Custom Agent has exactly one per Environment; **Development is the only editable one**, and every other is a copy placed there by a Publish. A Built-in Agent has one Profile per Organization holding only its Skills, parked at Development and applying everywhere ([ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)).
- Profiles carry no versions and no history: editing overwrites Development, and [Publish (Agent)](../../CONTEXT.md) overwrites the target, keeping nothing of what was there. The Store shows the difference between Development and a target as a drift strip — *Same as Development*, or which fields differ — and the publish dialog's confirm is disabled when the target is already identical.
- A [Project](../../CONTEXT.md) keeps the files it was created with. Editing or republishing an Agent reaches **no** existing Project: the definition is written into the workspace once, at create, and never re-derived ([Dynamic Delivery](dynamic-delivery.md)).
- The [Default environment (Agent)](../../CONTEXT.md) is the one new Projects are created from. Until the Agent holds a Profile there it is not offered in the picker at all, and the Store says so rather than letting an author believe it shipped.
- The `model` and `variant` pair is validated against the catalog the distribution carries; a model with no reasoning options takes no variant, and anything else is refused as `model-unknown`.

### Visibility and reuse

- [Visibility](skills.md) works exactly as it does for a Skill: **private** to its creator, or **public** to the whole Organization, irreversibly ([ADR-0057](../adr/0057-authored-skills-and-agents-are-private-or-public-within-one-organization.md)). A public Agent may not carry a private Skill, checked when the Skill is added, when the Agent is widened and at Publish.
- [Duplicate (Custom Agent)](../../CONTEXT.md) forks any Agent a member can see — public, Built-in, or their own — into a new private Custom Agent carrying its identity, instructions, model and Skills in Development. Nothing records what it was copied from, and it is the only way back from a Visibility already made public.
- [Archive (Agent)](../../CONTEXT.md) hides a Custom Agent from the picker, closes it to new Projects and drains its warm pool while existing Projects run on; it is reversible. A never-published or archived Agent can be deleted outright. Built-in Agents are never archived — one that leaves the registry stops being offered.

## States

A Custom Agent's availability for new Projects.

| State | What happens |
|---|---|
| No Profile at its Default environment | Absent from the picker; the Store warns rather than failing silently |
| Private | Offered to its creator only; editable by its creator only |
| Public | Offered to and editable by the whole Organization |
| Archived | Absent from the picker, pool drained, existing Projects unaffected; reversible |
| Deleted | Row gone; only available while never published or already archived |

## Edge cases

- When Development is chosen as the Default environment, every new Project picks up whatever Development holds at that moment — the fast-iteration mode, and the reason a test Project is single-use.
- When an Agent is made public while carrying a private Skill, the widening is refused rather than the Skill being silently dropped.
- When a Skill is removed from a Profile, the toast's **Undo** restores the pin at its **old** Version, not the newest one.
- When a Project's Agent is later archived or deleted, the Project keeps resolving it by id and keeps running.
- When a Project is imported into an Organization that has no such Agent, `projects.imported_agent` records the original slug and the pod runs the shared package against the prompt the export carried.

## Code

- `backend/src/agent/` — the `agents` rows, the Profile service, the visibility predicate and the Custom Agent routes.
- `backend/src/store/agent-profile.repository.ts` — the Profile and its pinned Skills, per Environment.
- `frontend/src/pages/store/agent-page.tsx` — the Agent page, the Development panel, the drift strip and the publish dialog.

## Related

- [Skill](skills.md) — what a pinned Skill is and how its Versions work.
- [Dynamic Delivery](dynamic-delivery.md) — when a definition reaches a workspace, and when it does not.
- [Agent](agent.md) — the Built-in side: the registry, the image and the model catalog.
- [Skill & Agent Builder](skill-agent-builder.md) — authoring and testing a Custom Agent by conversation.
