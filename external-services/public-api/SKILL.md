---
name: service-public-api
description: How to act on this Organization's Agents, Skills and Projects through the Opsiforce Public API External Service (`public-api`), as the human who created this Project.
---

# Opsiforce Public API

`public-api` is the platform's own API, reached as an External Service. Every Operation acts as the human who created this Project, with that human's current permissions, and only on what that human can see. Projects, Skills and Agents you create are stamped as made by this Project. Those are the only Projects you can reach, and the only Skills and Agents you can change, besides the one a builder chat is about; every other Skill and Agent is read-only to you.

## Inputs

An Operation's input is one flat object: path fields (`id`, `skillId`, `environmentId`), query fields (`limit`, `cursor`, `filter`) and body fields side by side. Reads are on everywhere; writes and destructive Operations are on only where this Project's configuration turns them on.

## Answers and refusals

- An answer is the platform API's JSON; an Operation that answers nothing gives `{}`.
- A refusal from the platform keeps its `code` (`project-not-found`, `permission-denied`, `validation-error`, `name-unavailable`, …) and its `detail`; read the `detail`, it says what to change.
- `chain-too-deep` (409) on `create_project`: this Project was itself made by a chain of Projects as deep as the platform allows. Do not retry; do the work in this Project or ask the user.
- `permission-denied` names the `permission` the creator lacks, or says the Skill or Agent was not made by this Project. Tell the user which permission their account needs, or that this Project may only read that one; do not look for another way round.

## Habits

- List before you create: `list_skills`, `list_agents`, `list_projects` page with `cursor` until `nextCursor` is null.
- After `create_project`, poll `get_project` until the Development environment is active, or call `connect_project`, which waits for it.
- Delete the Projects you made for a test once you have what you needed from them.
