---
kind: explanation
terms: [Publish, Publish with data, Environment Variables, Restart (environment)]
adrs: [0004, 0107]
---

# Publish

> How does an App's source move from Development into another ProjectEnvironment, and how does each environment keep its own variables across updates?

## How it works

### Publish

- A [Publish](../../GLOSSARY.md) commits [Development](../../GLOSSARY.md)'s working tree and makes the target a local git clone reset to that commit; a Publish update syncs only the diff ([ADR-0004](../adr/0004-git-based-incremental-publish.md)).
- The workspace `.gitignore` is the deploy boundary: the target's database, installed dependencies, and Environment Variables file are outside git and survive every update. [User uploads](../../GLOSSARY.md) and [Generated files](../../GLOSSARY.md) are on the platform's ignore list too, so they stay in the environment where they were made; a Publish first adds any missing platform entries to Development's `.gitignore` and untracks copies committed before, which the target then drops ([ADR-0107](../adr/0107-a-publish-carries-the-apps-data-only-when-asked-by-mirroring-developments-data-folder-and-replaces-nothing-the-target-owns-unless-chosen.md)).
- A [Publish with data](../../GLOSSARY.md) also replaces the target's `app/data/` with Development's, and nothing else: the job stops the target's pod, holds Development in `publishing` with its pod deleted, checks Development still holds data, moves the target's `app/data/` to `.opsiforce/replaced-app-data/<publish job id>/` and copies Development's in its place with owners and modes kept, then starts Development again when it was running.
- A failed Publish with data puts the moved-aside data back; a backend restart that strands one waits for the target's pod to stop, does the same and starts Development again. A successful one deletes the moved-aside data, which is never put back after that, and adds an `app-data` line to the report ([ADR-0107](../adr/0107-a-publish-carries-the-apps-data-only-when-asked-by-mirroring-developments-data-folder-and-replaces-nothing-the-target-owns-unless-chosen.md)).
- The deployed commit is recorded per [ProjectEnvironment](../../GLOSSARY.md); a failed or interrupted Publish resets the target to the previous commit and variables.
- Cancel publish ends a Publish that is `queued` or waiting for its App (`building`, `migrating`) the way a failure does, so a fixed version can be published right after. A `queued` one is just marked failed, and one in `committing` or `swapping` answers `409` until that step is over.
- The worker runs several Publishes at once, one at a time per Project, so a Publish waiting on a broken App holds up only its own Project.
- `.opencode/` is outside git, so a Publish into a target that has no `.opencode/` yet — a first Publish — copies the backend-owned half of it — `opencode.json`'s `default_agent`, a [Custom Agent](../../GLOSSARY.md)'s prompt file and the delivered Skill directories, with their bookkeeping rows — into the empty target before its pod is created; the pod's init container lays the image-owned half. A target that already has `.opencode/` keeps it untouched, because it already holds the same snapshot ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- A Publish update keeps the target's `app/app.meta.json`, so [App Details](../../GLOSSARY.md) curated there survive; only a first Publish carries Development's.
- A first Publish also creates the target's service-gateway key and, when Development's [Auth mode](../../GLOSSARY.md) is not public, seeds its [App Auth](../../GLOSSARY.md) ([Environments](environments.md)). Every Publish recreates the [Schedules](../../GLOSSARY.md) chosen in the form ([Schedule](schedule.md)). An [External Service Builder](../../GLOSSARY.md) Project is published only from its [Custom External Service](../../GLOSSARY.md)'s page (`POST /api/external-services/services/<id>/publish`); this route answers `409 publish-from-service-page` for it. Publishing it for the first time also sets the service's [Default environment (External Service)](../../GLOSSARY.md) to the target, once the deploy has succeeded; later Publishes leave it alone. Every Publish that lands on the Default environment fills generated fields the new `service.json` newly declares, runs the Service configuration hook the Publish dialog deferred and delivers the Service skill again.
- Once the new App version is ready, a Publish copies the [Project configurations](../../GLOSSARY.md) of the services chosen in its form onto the target, one service at a time. The form lists every service Development holds one for, chosen in advance only where the target has none of its own, and a request without a choice carries exactly those: values and labels overwrite the target's, and each secret is opened at Development's place and sealed again at the target's. A unique generated value (an inbound address) is never copied: the target keeps its own, or gets a new one the first time. A service Development has no configuration for keeps whatever the target holds. Each carried configuration counts as a save of the target for the service's after-save hook. A service newly configured in the target brings its [Service skill](../external-services/service-skill.md) there.
- The same step replaces the target's [switched-off](../../GLOSSARY.md) Skills (`project_environment_skills_off`) with Development's and fans the change out to the target, so a Skill switched off in Development is removed there and one switched back on is laid again ([ADR-0085](../adr/0085-a-project-environment-switches-skills-off-by-a-stored-choice-and-the-chat-bar-derives-the-rest.md)).
- Progress streams stage by stage over the project's SSE event stream and is rendered by the [Job Dock](../frontend/job-dock.md). The job's report holds one line per carried service and one `skills-off` line naming the Skills newly switched off or back on in the target when its set changed.

### Environment Variables

- Each ProjectEnvironment stores its [Environment Variables](../../GLOSSARY.md) in `app/opsiforce.env.json`, read once when the App starts; the file is excluded from the publish sync.
- The publish form pre-fills keys from Development and values from the target, pre-checks Development's Schedules for an opt-out copy, lists the External Services to carry, and offers the Publish with data toggle, off each time and disabled with "Development has no data to copy" while Development's `app/data/` is empty or missing.
- The row-menu editor edits the file for any environment, Development included, and offers a "Restart app to apply now" toggle that performs an App restart through the in-pod control process ([ADR-0009](../adr/0009-in-pod-control-process.md)).
- An App restart kills only the App's processes so the in-pod guards revive them with the new values: every process run by a `guard` that `startup.sh` started, whatever its name, while `startup.sh` itself keeps running so production does not reinstall or rebuild. When the control process kills nothing because `startup.sh` supervises nothing, or cannot be reached, answers an error or has no control token to check, the backend recreates the pod instead ([ADR-0009](../adr/0009-in-pod-control-process.md)). The row-level [Restart (environment)](../../GLOSSARY.md) always recreates the whole pod ([Pod Lifecycle](../runtime/pod-lifecycle.md)).

### In the workspace

- Publish sits on each non-Development row of the Environments switcher ([Environments](environments.md)), pre-targeted, reads "Publish update" once something runs there, and always confirms first; a Publish update with data is confirmed by typing the Environment's name.
- Gated by `can_publish_project` and `can_manage_environment_variables` ([Permissions](../organization/permissions.md)).

## States

Publish job stages in order, during which the target ProjectEnvironment holds status `publishing` from `swapping` until `done` or `failed`.

| Stage | What happens |
|---|---|
| `queued` | The job waits for the publish worker |
| `committing` | Development's working tree is committed |
| `swapping` | First Publish: the target directory is cloned and reset to the commit, and the backend-owned `.opencode/` files are copied in. Update: the diff is synced and the previous variables are backed up. With data, Development's `app/data/` replaces the target's. Variables are written |
| `building` | The target pod is recreated on the new tree |
| `migrating` | The backend waits for the App to report ready ([Go-live](../../GLOSSARY.md)) |
| `done` | The deployed commit is recorded; the target serves the new App |
| `failed` | Update: files, variables and any replaced `app/data/` go back to what the target held. First Publish: nothing to roll back to |

## Edge cases

- When the environment has no running pod, "Restart app to apply now" only writes the file, and the App reads it on its next start.
- A Publish whose pod never reports ready within the deploy window fails and rolls back like any other failure.
- Schedule recreation failing after a healthy Publish is logged and does not fail the Publish.
- A Project configuration that cannot be carried, such as one whose secret no longer opens at Development's place, gets a report line instead of failing the Publish; the target keeps its own configuration and Development keeps receiving.
- A Publish job found already `done` or `failed` when the worker picks it up is skipped.
- A cancel sent while a Publish is `building` takes effect once the pod is up; cancelling pod creation midway would race the rollback's own pod.
- A Publish with data is refused with `400 no-development-data` when Development's `app/data/` is empty, and with `409` while Development is starting or publishing (`development-busy`) or its agent is working (`development-agent-working`).
- Publish and Duplication cannot run against the same [Project](../../GLOSSARY.md) at once, since both begin by committing the same working tree.

## Code

- `backend/src/publish/` — publish job, worker, stage order and the SSE stage stream; `app-data.ts` moves, mirrors and restores `app/data/`.
- `backend/src/delivery/` — the copy of the backend-owned `.opencode/` files into a first-publish target.
- `backend/src/external-services/configuration/project-configuration-carry.ts` — the Project configuration carry and its report lines.
- `backend/src/delivery/environment-skills.ts` — the switched-off Skills carry and its report line.
- `backend/src/git/` — commit, clone, reset and diff sync between Development and the target.
- `backend/src/project-environment/environment-variables.service.ts` — reads and writes each environment's variables file and triggers the App restart.
- `proxy/cmd/agent-control/` — the in-pod control process that performs the App restart.
- `frontend/src/components/project/environments/` — the publish dialog, its step list and the Environment Variables editor.

## Related

- [Environments](environments.md) — the two-entity model, Environment Slugs, App Auth, the switcher.
- [App Readiness](app-readiness.md) — how Go-live of a freshly published environment is detected.
- [Job Dock](../frontend/job-dock.md) — the progress card and dialog every long job shares.
- [Duplication](duplication.md) — copies a whole Project through the same git path.
