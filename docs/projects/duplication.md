---
kind: explanation
terms: [Duplicate]
adrs: [0011]
---

# Duplication

> How is a whole [Project](../../GLOSSARY.md), working state included, copied into a new independent Project on the same deployment?

## How it works

- A [Duplicate](../../GLOSSARY.md) is a new Project in the same tenant and Workspace, copied from the source's [Development](../../GLOSSARY.md) environment only; published environments are re-created by publishing from the copy.
- Carried: App source and git history, the agent's chat and session state, the App's databases, [Environment Variables](../../GLOSSARY.md), project settings (timeouts, [Request Logging](../../GLOSSARY.md)), [Resources](../../GLOSSARY.md), and [App Details](../../GLOSSARY.md) with the [App Slug](../../GLOSSARY.md), or one from the App's name when the source has none, cut to fit beside the copy's own App Short ID so the copy's [Public URL](../../GLOSSARY.md) reads like the source's; a copy with manual [App Auth](../../GLOSSARY.md) gets none ([Public URL](public-url.md)).
- Development's [App Auth](../../GLOSSARY.md) is seeded onto the copy's own hosts before its job is queued, fail-closed, by cloning the source's gate the way a first [Publish](publish.md) seeds a new environment, so the copy's [Auth mode](../../GLOSSARY.md), authentication bypass paths and sign-in settings match the source's ([ADR-0007](../adr/0007-per-environment-app-auth.md), [Environments](environments.md)).
- Made fresh: the Project's LLM keys and service-gateway key; a Duplicate never shares credentials or budget plumbing with its source. Not carried: the source's publish jobs and audit logs.
- [Schedules](../../GLOSSARY.md) are carried paused, so a Duplicate never fires the same automation as its original until someone enables them ([Schedule](schedule.md)).
- Duplication runs on the same git mechanism as [Publish](publish.md): commit the source's working tree, make the Duplicate a local clone, detach it from its origin ([ADR-0011](../adr/0011-duplication-reuses-git-publish-path.md)).
- Runtime state that git ignores, including databases, the session store, the variables file and the installed dependency store, is then copied subtractively: everything ignored, minus a small skip-list of caches the App regenerates. Each copied entry keeps its mode and its owner, so a container that runs as its own user, such as a database server, still owns its data in the copy.
- The job reports step progress (snapshot, clone, runtime-state copy, App starting) over its own SSE stream into the [Job Dock](../frontend/job-dock.md); the new Project shows as `starting` and "Open project" appears once its App responds ([App Readiness](app-readiness.md)).
- A [Builder chat](../../GLOSSARY.md) is refused with `not_duplicable`, because a copy would belong to no Skill or Agent ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)); the menu offers Duplicate only on ordinary Projects.
- Gated by `can_duplicate_project` ([Permissions](../organization/permissions.md)); the Duplicate lands in the source's Workspace, so it never widens who can see a Project.

## Edge cases

- When the copy's App Auth cannot be written, such as for a protected source whose gate cannot be read, the Duplicate is refused and no copy is left behind.
- When the source is `manual`, sign-in on the copy fails until the callback URLs its App Auth dialog lists are registered with the customer's identity provider.

## Code

- `backend/src/project/project.service.ts` — `duplicateOne`: the copy's rows, keys and App Auth, then the job.
- `backend/src/project/project-duplicate.processor.ts` — the job: snapshot, clone, subtractive copy, boot.
- `backend/src/git/` — commit and local clone shared with Publish.
- `frontend/src/components/project/jobs/` — the progress card and dialog.

## Related

- [Publish](publish.md) — the git path Duplication reuses.
- [Export and Import](export-import.md) — the same copy across deployments, as a file.
- [Job Dock](../frontend/job-dock.md) — the shared progress surface.
