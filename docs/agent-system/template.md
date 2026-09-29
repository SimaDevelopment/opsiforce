---
kind: explanation
terms: [Template]
adrs: [0073]
---

# Template

> Where is a Custom Agent's Template kept, how is it saved and published, and how does it reach a new Project?

## How it works

### What it is for

- A [Template](../../CONTEXT.md) is not a way to update existing Projects: a [Project](../../CONTEXT.md) keeps the files it was created with ([Dynamic Delivery](dynamic-delivery.md)).
- A Template is not where a runtime gets installed in the image. A stack the image lacks is installed by the Template's own `startup.sh` into `/workspace`.

### Store and save

- A [Custom Agent](../../CONTEXT.md) holds at most one Template per Environment, kept on the shared volume beside `projects/` and never in the database: `agent-templates/<agentId>/<environmentId>` is a relative link to an immutable `.versions/<hash>/` folder, no link means no Template, and the hash is the Skill-tree hash of paths, modes and bytes ([ADR-0073](../adr/0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)). `GET /agents/{id}` reports `template: { hash, damaged } | null` on every Environment entry, where `damaged` marks a link whose version folder is missing.
- The Development Template is written only by the Agent's own [Builder chat](../../CONTEXT.md), through `PUT /agents/{id}/template`, which mirrors the chat workspace's `template/` folder under a per-Agent advisory lock: it copies into a dot-prefixed staging folder while hashing, hashes the source again and answers `template-changed` when the two differ, then renames the staging folder into its version (or drops it when that version exists), switches the link with one `rename()` and deletes the old version once nothing links to it. A missing or empty `template/` removes the Template.
- One filter table decides every path a save meets: symlinks, `app/opsiforce.env.json`, `app/app.meta.json` and `.env*` files other than `*.example` are refused, all listed at once as `template-refused` with nothing saved; instruction files opencode would load (`AGENTS.md` at any depth, a root `opencode.json`/`opencode.jsonc`, `.claude/` and `.agents/`), platform folders, installed dependencies and package-manager state, any `data/`, caches, chat uploads and generated files, and whatever the Template's own `.gitignore` files exclude are skipped and listed, so the Agent's body stays its only instruction source. Key-like strings are saved and listed as warnings; file modes are kept, and `CLAUDE.md`, `.cursor/` and a root `.gitignore` are ordinary files.

### Into a Project

- At Project create, delivery lays the Template from the same Environment the behaviour is read from — the [Default environment (Agent)](../../CONTEXT.md), or Development for a [Test Project](../../CONTEXT.md) — **before** it writes the prompt and Skills and before the pod exists, and the create request waits for the copy. It reads the link, copies that version into a dot-prefixed staging folder inside the new workspace while hashing, checks the copy against the version's hash (re-reading the link and retrying up to three times on a mismatch) and moves the entries into the workspace root; readers take no lock ([ADR-0073](../adr/0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)).
- The init container then commits the laid files as the first commit, "Initial template", and when the Template carries a root `.gitignore` it appends every missing platform line under a `# platform` marker, so a Template adds its own ignores but cannot un-ignore platform paths ([Agent](agent.md)). An [Update (Test Project)](../../CONTEXT.md) that overlays a root `.gitignore` appends the same lines before it commits.
- The pool, Duplicate (Project), Import (Project) and Publish (App) have no Template step: a pool slot is always a Built-in Agent's, and the others copy a workspace that already holds its files.

### Publish, Delete and cleanup

- [Publish (Agent)](../../CONTEXT.md) carries the Development Template with the Profile rows, inside one transaction: it takes the per-Agent advisory lock, diffs and writes the rows, reads Development's link, switches the target's link to the same version (or removes it when Development has none), deletes the target's old version once nothing links to it, and commits. The no-op check counts the Template, so a Template-only change is published, and the `applied` response reports `template` as `same`, `changed`, `added`, `removed` or `none`.
- Deleting an Agent removes its whole `agent-templates/<agentId>/` folder once its row delete has committed, under the same per-Agent lock so a save in flight finishes first; disabling does no filesystem work.
- The daily workspace-cleanup job sweeps the rest: it removes the folder of an Agent whose row is gone once the folder has sat untouched for an hour, removes staging folders older than the seven-day retention, and for each live Agent, under a try-lock that skips a busy Agent until the next run, removes versions no link points at.

## Edge cases

- When a create meets a link to a missing version, a copy error or a mismatch after three retries, it discards the half-made Project and fails.
- When a Publish (Agent) link step fails, the rows roll back; a failed delete of the old version leaves it for the cleanup job, and a link switched before a failed commit is set right by publishing again.
- When Development links to a missing version, Publish (Agent) is refused as `template_damaged`, asking the author to save again.
- When a Template removal on Delete fails, the request still succeeds and the cleanup job removes the folder later.
- When the cleanup job finds a link to a missing version, it logs it and never removes it, so creates keep failing loudly.

## Code

- `backend/src/agent-template/` — the Template store: the volume layout, the save and its filter table, the lay, the Publish link switch, removal and the sweep.
- `backend/src/delivery/delivery.service.ts` — the lay at create and the overlay an Update (Test Project) applies.
- `backend/src/cleanup/workspace-cleanup.processor.ts` — the daily job that runs the sweep.
- `agent-config/scripts/agent-workspace-migrate.mjs` — the init container's first commit and its platform ignore lines.

## Related

- [Custom Agents](custom-agents.md) — the Agent a Template belongs to, and its Profiles per Environment.
- [Dynamic Delivery](dynamic-delivery.md) — what else delivery writes into a new workspace, and when.
- [Test Project](test-project.md) — the Project the Builder lays Development's Template into, and its Update and Reset.
- [Storage](../runtime/storage.md) — the `templates` bucket that measures `agent-templates/`.
