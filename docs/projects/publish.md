---
kind: explanation
terms: [Publish, Environment Variables, Restart (environment)]
adrs: [0004]
---

# Publish

> How does an App's source move from Development into another ProjectEnvironment, and how does each environment keep its own variables across updates?

## How it works

### Publish

- A [Publish](../../CONTEXT.md) commits [Development](../../CONTEXT.md)'s working tree and makes the target a local git clone reset to that commit; a Publish update syncs only the diff ([ADR-0004](../adr/0004-git-based-incremental-publish.md)).
- The workspace `.gitignore` is the deploy boundary: the target's database, installed dependencies, and Environment Variables file are outside git and survive every update.
- The deployed commit is recorded per [ProjectEnvironment](../../CONTEXT.md); a failed or interrupted Publish resets the target to the previous commit and variables.
- `.opencode/` is outside git, so a Publish into a target that has no `.opencode/` yet — a first Publish — copies the backend-owned half of it — `opencode.json`'s `default_agent`, a [Custom Agent](../../CONTEXT.md)'s prompt file and the delivered Skill directories, with their bookkeeping rows — into the empty target before its pod is created; the pod's init container lays the image-owned half. A target that already has `.opencode/` keeps it untouched, because it already holds the same snapshot ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- A first Publish also creates the target's service-gateway key and, when Development's [Auth mode](../../CONTEXT.md) is not public, seeds its [App Auth](../../CONTEXT.md) ([Environments](environments.md)). Every Publish carries inbound [external-service](../external-services/service-template.md) wiring and recreates the [Schedules](../../CONTEXT.md) chosen in the form ([Schedule](schedule.md)).
- Progress streams stage by stage over the project's SSE event stream and is rendered by the [Job Dock](../frontend/job-dock.md).

### Environment Variables

- Each ProjectEnvironment stores its [Environment Variables](../../CONTEXT.md) in `app/opsiforce.env.json`, read once when the App starts; the file is excluded from the publish sync.
- The publish form pre-fills keys from Development and values from the target, and pre-checks Development's Schedules for an opt-out copy.
- The row-menu editor edits the file for any environment, Development included, and offers a "Restart app to apply now" toggle that performs an App restart through the in-pod control process ([ADR-0009](../adr/0009-in-pod-control-process.md)).
- An App restart kills only the App's processes so the in-pod guards revive them with the new values: every process run by a `guard` that `startup.sh` started, whatever its name, while `startup.sh` itself keeps running so production does not reinstall or rebuild. When the control process kills nothing because `startup.sh` supervises nothing, or cannot be reached, answers an error or has no control token to check, the backend recreates the pod instead ([ADR-0009](../adr/0009-in-pod-control-process.md)). The row-level [Restart (environment)](../../CONTEXT.md) always recreates the whole pod ([Pod Lifecycle](../runtime/pod-lifecycle.md)).

### In the workspace

- Publish sits on each non-Development row of the Environments switcher ([Environments](environments.md)), pre-targeted, reads "Publish update" once something runs there, and always confirms first.
- Gated by `can_publish_project` and `can_manage_environment_variables` ([Permissions](../organization/permissions.md)).

## States

Publish job stages in order, during which the target ProjectEnvironment holds status `publishing` from `swapping` until `done` or `failed`.

| Stage | What happens |
|---|---|
| `queued` | The job waits for the publish worker |
| `committing` | Development's working tree is committed |
| `swapping` | First Publish: the target directory is cloned and reset to the commit, and the backend-owned `.opencode/` files are copied in. Update: the diff is synced and the previous variables are backed up. Variables are written |
| `building` | The target pod is recreated on the new tree |
| `migrating` | The backend waits for the App to report ready ([Go-live](../../CONTEXT.md)) |
| `done` | Deployed commit and pod IP are recorded; the target serves the new App |
| `failed` | Update: files and variables reset to the previous commit. First Publish: nothing to roll back to |

## Edge cases

- When the environment has no running pod, "Restart app to apply now" only writes the file, and the App reads it on its next start.
- A Publish whose pod never reports ready within the deploy window fails and rolls back like any other failure.
- Schedule recreation failing after a healthy Publish is logged and does not fail the Publish.
- A Publish job found already `done` or `failed` when the worker picks it up is skipped.
- Publish and Duplication cannot run against the same [Project](../../CONTEXT.md) at once, since both begin by committing the same working tree.

## Code

- `backend/src/publish/` — publish job, worker, stage order and the SSE stage stream.
- `backend/src/delivery/` — the copy of the backend-owned `.opencode/` files into a first-publish target.
- `backend/src/git/` — commit, clone, reset and diff sync between Development and the target.
- `backend/src/project-environment/environment-variables.service.ts` — reads and writes each environment's variables file and triggers the App restart.
- `proxy/cmd/agent-control/` — the in-pod control process that performs the App restart.
- `frontend/src/components/project/environments/` — the publish dialog, its step list and the Environment Variables editor.

## Related

- [Environments](environments.md) — the two-entity model, public URLs, App Auth, the switcher.
- [App Readiness](app-readiness.md) — how Go-live of a freshly published environment is detected.
- [Job Dock](../frontend/job-dock.md) — the progress card and dialog every long job shares.
- [Duplication](duplication.md) — copies a whole Project through the same git path.
