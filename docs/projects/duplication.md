---
kind: explanation
terms: [Duplicate]
adrs: [0011]
---

# Duplication

> How is a whole [Project](../../CONTEXT.md), working state included, copied into a new independent Project on the same deployment?

## How it works

- A [Duplicate](../../CONTEXT.md) is a new Project in the same tenant and Workspace, copied from the source's [Development](../../CONTEXT.md) environment only; published environments are re-created by publishing from the copy.
- Carried: App source and git history, the agent's chat and session state, the App's databases, [Environment Variables](../../CONTEXT.md), the Development [Auth mode](../../CONTEXT.md), project settings (timeouts, [Request Logging](../../CONTEXT.md)), [Resources](../../CONTEXT.md), and [App Details](../../CONTEXT.md).
- Made fresh: the Project's LLM keys and service-gateway key; a Duplicate never shares credentials or budget plumbing with its source. Not carried: the source's publish jobs and audit logs.
- [Schedules](../../CONTEXT.md) are carried paused, so a Duplicate never fires the same automation as its original until someone enables them ([Schedule](schedule.md)).
- Duplication runs on the same git mechanism as [Publish](publish.md): commit the source's working tree, make the Duplicate a local clone, detach it from its origin ([ADR-0011](../adr/0011-duplication-reuses-git-publish-path.md)).
- Runtime state that git ignores, including databases, the session store, the variables file and the installed dependency store, is then copied subtractively: everything ignored, minus a small skip-list of caches the App regenerates.
- The job reports step progress (snapshot, clone, runtime-state copy, App starting) over its own SSE stream into the [Job Dock](../frontend/job-dock.md); the new Project shows as `starting` and "Open project" appears once its App responds ([App Readiness](app-readiness.md)).
- Gated by `can_duplicate_project` ([Permissions](../organization/permissions.md)); the Duplicate lands in the source's Workspace, so it never widens who can see a Project.

## Code

- `backend/src/project/project-duplicate.processor.ts` — the job: snapshot, clone, subtractive copy, boot.
- `backend/src/git/` — commit and local clone shared with Publish.
- `frontend/src/components/project/jobs/` — the progress card and dialog.

## Related

- [Publish](publish.md) — the git path Duplication reuses.
- [Export and Import](export-import.md) — the same copy across deployments, as a file.
- [Job Dock](../frontend/job-dock.md) — the shared progress surface.
