---
kind: explanation
terms: [Custom Agent, Built-in Agent, Agent Profile, Publish (Agent), Default environment (Agent), Disable (Agent)]
adrs: [0054, 0057, 0058]
---

# Custom Agents

> How an Agent authored in the platform is defined per Environment, published, made visible and retired?

## How it works

### Two kinds, one table

- A [Built-in Agent](../../CONTEXT.md) is a global row reconciled from the image registry; a [Custom Agent](../../CONTEXT.md) is a row owned by one Organization. They share the `agents` table and are told apart by `origin` and by whether `tenant_id` is set, so one slug may name a Built-in Agent globally and a different Organization's own Agent at the same time without collision ([ADR-0054](../adr/0054-built-in-and-custom-agents-share-one-agents-table-told-apart-by-origin.md)).
- A Custom Agent carries no workspace migrations. Its Projects boot the image's shared `custom` package and open on the Agent's [Template](../../CONTEXT.md) when it has one, otherwise on an empty workspace. The web-app starter reaches a Custom Agent's `app/` only through its Template, as a snapshot the [Skill & Agent Builder](skill-agent-builder.md) copied and edited: the `web-app` skill never lays it, and stops and tells the user when `app/` does not hold it. Another stack starts from a skeleton the Builder wrote into the Template, a Skill carries know-how and never files to copy, and the prompt body's **Architecture** section holds three to six rules every Project keeps, so every Project of the Agent keeps one shape ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- A Built-in Agent's page lists the Skills its package ships, read from the agent image and always delivered, beside the Skills the Organization added to its Profile. The list is exactly what the image composes for that package, so Makara App Builder lists neither `web-app` nor `dates`, and an Organization pin on either is delivered like any other ([Dynamic Delivery](dynamic-delivery.md)).
- Only the fields an author writes are the Agent's own: display name, description, prompt body, [Agent Model](../../CONTEXT.md) pair and [Agent Skills](skills.md). Everything else — tools, permissions, the platform facts — belongs to the pod and to the [Platform Skill](platform-skill.md).

### What a Custom Agent can be

A Template is what every new Project starts with, and the App is whatever `startup.sh` serves on `$APP_PORT`; an Agent can have either, both or neither. The Builder decides which from the author's brief. This table is for readers and is never copied into a prompt or a Skill.

| Use case | Template holds | App? | The child delivers | "Finished" is checked by |
|---|---|---|---|---|
| **App on the platform starter** (a shop inventory) | a snapshot of App Builder's starter plus the domain's schema and pages | yes | the user's changes to a working App | the App boots, and the changed flow works in a browser |
| **Writer from reference files** (on-brand letters and one-pagers) | brand guide, letterhead and layout files | no | documents in the workspace | opening the delivered file and comparing it with the guide |
| **App host** for third-party open-source apps | none | yes | someone else's app running on the App contract, its data kept | the app serves on the preview, and its data survives a restart |
| **App on its own non-Node stack** (Go services) | a skeleton whose `startup.sh` installs its toolchain into `/workspace/.cache` | yes | a working service | the service boots, and its API and page work |
| **Data analyst** (monthly sales reports) | analysis scripts, a dependency manifest, a report layout and a sample dataset, with no `startup.sh` | no, but code runs | a report with charts built from the user's uploaded data | the scripts run on the user's data, and the numbers match the input |
| **Conventions checker or generator** (OpenAPI specs to a house style) | a style guide plus a check script the body names | no | files that pass the shipped check | the shipped check exits 0 after the last change |
| **Know-how only** | none; Custom Skills carry the rules | either | anything | whatever the body's definition of finished says |
| **Branded copy of a Built-in** (a client-branded App Builder) | inherited from the Built-in's template, then edited | as the source | as the source | as the source |
| **Moving an Agent** between Organizations or deployments | carried in the Agent export | as the source | as the source | a Project in the target has the same Template |
| **Static site or docs generator** | site sources | yes | a built site | the site builds and serves |

### One definition per Environment

- An [Agent Profile](../../CONTEXT.md) is the Agent's definition in one scope. A Custom Agent has exactly one per Environment; **Development is the only editable one**, and every other is a copy placed there by a Publish ([ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)). A Built-in Agent has one Profile per Organization holding only its Skills, parked at Development, applying everywhere and created the first time its Skills are read or changed there ([ADR-0051](../adr/0051-skills-are-stored-as-immutable-per-file-versions-and-a-built-in-agents-skills-live-on-a-development-profile.md)).
- Profiles carry no versions and no history: editing overwrites Development, and [Publish (Agent)](../../CONTEXT.md) overwrites the target, keeping nothing of what was there. The Agent page lists every Environment beside the open one, with its drift — *Same as Development*, or which of prompt, model, skills and template differ — and the Publish dialog repeats it per target, shows a Template line (*Same*, *Changed*, *Added* or *Removed*, hidden when neither side has a Template) beside Prompt, Model and Skills, disables its confirm when the target is already identical, and holds the [Default environment (Agent)](../../CONTEXT.md) choice.
- A [Project](../../CONTEXT.md) keeps the files it was created with. Editing or republishing an Agent reaches **no** existing Project: the definition is written into the workspace once, at create, and never re-derived ([Dynamic Delivery](dynamic-delivery.md)).
- The Default environment is the one new Projects are created from, marked **Default** in the Store. A new Custom Agent's is Production, and Development can never be chosen: Settings refuses it and the Publish dialog does not offer it ([ADR-0058](../adr/0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)). Until the Agent holds a Profile there it is not offered in the picker at all — a new Agent reaches it on its first Publish (Agent) — and the Store says so.
- A [Test Project](../../CONTEXT.md) is the exception: it always reads the Agent's Development Profile, whatever the Default environment is, so the Builder tests what it just saved ([Test Project](test-project.md)).
- A Custom Agent holds at most one [Template](../../CONTEXT.md) per Environment, written in Development by its [Builder chat](../../CONTEXT.md) and carried by Publish (Agent) beside the Profile; how it is stored, saved, laid and cleaned up is on [Template](template.md).
- The `model` and `variant` pair is validated against the catalog the distribution carries; a model with no reasoning options takes no variant, and anything else is refused as `model-unknown`.

### Visibility and reuse

- [Visibility](skills.md) works exactly as it does for a Skill: **private** to its creator, or **public** to the whole Organization, irreversibly ([ADR-0057](../adr/0057-authored-skills-and-agents-are-private-or-public-within-one-organization.md)). A public Agent may not carry a private Skill, checked when the Skill is added, when the Agent is widened and at Publish.
- [Duplicate (Agent)](../../CONTEXT.md) forks any Agent a member can see into a new private Custom Agent, and [Export (Agent)](../../CONTEXT.md) and [Import (Agent)](../../CONTEXT.md) carry a Custom Agent's Development definition to another Organization or deployment as a new Agent there ([Agent Copies](agent-copies.md)).
- [Disable (Agent)](../../CONTEXT.md) hides an Agent — Custom or Built-in — from one Organization's picker and closes it to new Projects there, while existing Projects run on; Enable reverses it, on `POST /agents/:id/disable` and `/enable` ([ADR-0070](../adr/0070-skills-and-agents-are-disabled-per-organization-like-projects.md)). The choice is a row in `tenant_disabled_agents`, so a Built-in Agent stays on for every other Organization and the global warm pool is untouched ([ADR-0070](../adr/0070-skills-and-agents-are-disabled-per-organization-like-projects.md)). A disabled Agent stays editable and publishable — its profile, Skills and Builder chat all still work — because disabling only closes it to new Projects, its chat's Test Project included.
- An Organization cannot disable its last enabled Built-in Agent, and the Skill & Agent Builder is never disabled. A Project created without naming an Agent starts on `app-builder`, or on the first Built-in Agent still enabled when that is disabled.
- An Agent never published beyond Development, or disabled, can be deleted outright once no Project runs on it; its Test Projects, its [Builder chat](../../CONTEXT.md) and its Templates are removed with it, and a Test Project never counts as a Project running on it. A Built-in Agent that leaves the registry stops being offered.

## States

An Agent's availability for new Projects in one Organization.

| State | What happens |
|---|---|
| No Profile at its Default environment | Absent from the picker; the Store warns rather than failing silently |
| Private | Offered to its creator only; editable by its creator only |
| Public | Offered to and editable by the whole Organization |
| Disabled | Absent from this Organization's picker, existing Projects unaffected; reversible |
| Deleted | Row gone, Test Projects, Builder chat and Templates with it; only while never published beyond Development or already disabled, and no Project runs on it |

## Edge cases

- When an Agent's Default environment is Development, every new Project picks up whatever Development holds at that moment until an author picks another Environment.
- When an Agent is made public while carrying a private Skill, the widening is refused rather than the Skill being silently dropped.
- When a Skill is removed from a Profile, the toast's **Undo** restores the pin at its **old** Version, not the newest one.
- When a Project's Agent is later disabled, or a Built-in Agent leaves the registry, the Project keeps resolving it by id and keeps running.
- When a Project is imported into an Organization that has no such Agent, `projects.imported_agent` records the original slug and the pod runs the shared package against the prompt the export carried.

## Code

- `backend/src/agent/` — the `agents` rows, the Profile service, the visibility predicate and the Custom Agent routes.
- `backend/src/store/agent-profile.repository.ts` — the Profile and its pinned Skills, per Environment.
- `frontend/src/pages/store/agent-page.tsx` — the Agent page: the editable name and description, the Environment list and the Development panel.
- `frontend/src/components/store/entry-name-field.tsx` — the name field with its live slug, shared by New agent, New skill, Duplicate and Import.
- `frontend/src/pages/store/agent-publish-dialog.tsx` — the Publish dialog.

## Related

- [Skill](skills.md) — what a pinned Skill is and how its Versions work.
- [Dynamic Delivery](dynamic-delivery.md) — when a definition reaches a workspace, and when it does not.
- [Template](template.md) — the files a Custom Agent's new Projects start with, per Environment.
- [Agent Copies](agent-copies.md) — Duplicate, Export and Import of an Agent.
- [Agent](agent.md) — the Built-in side: the registry, the image and the model catalog.
- [Skill & Agent Builder](skill-agent-builder.md) — authoring and testing a Custom Agent by conversation.
