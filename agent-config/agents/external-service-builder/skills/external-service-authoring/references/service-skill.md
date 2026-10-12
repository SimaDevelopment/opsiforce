# The Service skill (`SKILL.md`)

`SKILL.md` in `/workspace/app` is what every consuming Agent reads about this service, as the Skill
`service-<slug>`. Its reader is an Agent doing a user's task in a Project (or writing the App code that
does it), never the admin who configures the service.

## What the Agent already has

Write the skill as the layer on top of these, which are always current:

- **describe** (`GET <service>`): each Operation's kind and title, whether it is on here, the Receive
  switches, the Project configuration with labels.
- **`openapi.json`**: every Operation's description and input schema, from your manifest.
- **The platform skill**: how to call any service, the App's `callService` helper, every Gate refusal and
  what to tell the user about it.
- **A "Calling it" footer** the platform appends to your skill with this service's URLs.

So the manifest is the single source of truth for each Operation. Put an Operation's purpose, inputs,
defaults and limits in its `description` and input schema in `service.json`; the skill names Operations
only inside workflows.

## What the skill holds

1. **Frontmatter**: `name` (any; the platform renames it `service-<slug>`) and a `description` that says
   what the outside system is and when to reach for this skill, as triggers an Agent will meet in a
   user's words.
2. **The system in one paragraph**: what it is, the concept a user names (a board, a repository, a
   mailbox) and how the Project's selection of them bounds every call.
3. **Workflows**: the user tasks that take more than one Operation, each as the sequence by name
   ("find the list's id with `list_lists`, then `move_card`").
4. **Gotchas no schema states**: ids that mean something only inside a parent, eventual consistency,
   writes that are not idempotent (check before retrying), what a user sees upstream (notifications).
5. **Events**, when the service has inbound: each type, when it arrives, and the keys of its `data`
   with their meaning, since App code reads them from `events` and nothing else documents them.

Aim for a page an Agent reads in one pass: 150 to 400 words, tables only for Event data.

## Checking it

Run `test-project/update` after every change to `SKILL.md`, and judge the conversation prompt partly on
it: an Agent that had to ask the person what an id means, or retried a write blindly, points at a missing
workflow or gotcha.
