# A Custom Agent's Template is a folder per Environment, copied into every new Project

A Custom Agent's Projects need the same starting files every time: an App's starting code, reference documents, assets, or anything else the Agent's work starts from. Copying those files in is faster, cheaper and more predictable than having the child re-create them from a description in every Project.

**A Custom Agent has at most one Template per Environment: a plain folder on the shared volume, which the backend copies into the root of every new Project's workspace before the pod starts. The Skill & Agent Builder authors the Development Template in its chat and saves it, and Publish (Agent) carries it with the rest of the Agent Profile.** A Project keeps the files it was created with ([ADR-0058](0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)), so a Template change reaches only Projects created after it.

## Storage

- Templates live under `agent-templates/<agentId>/` on the volume that holds `projects/`. The path comes from IDs, so the database holds nothing about a Template.
- Each Environment is a relative link, `agent-templates/<agentId>/<environmentId>` → `.versions/<hash>/`. A version folder is named by the hash of its content (path, mode and bytes) and is never changed after it is written. No link means no Template. An empty Template is never kept.
- A version is deleted as soon as no link points at it. There is no history and no rollback, as for Agent Profiles.
- Save, Publish and the Template part of Delete take one per-Agent Postgres advisory lock. A reader takes no lock. It verifies the hash of what it copied instead.
- There is no size cap.

## Save

- The Builder drafts in a fixed `template/` folder at the root of its chat's workspace, and saves with `PUT /agents/:id/template`, which has no body. Only the Agent's own Builder chat pod may call it ([ADR-0062](0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)'s gateway caller, whose Project is the Agent's Builder chat).
- A save mirrors `template/`: a file deleted there leaves the Template, and a missing or empty `template/` removes it. The backend copies into a staging folder while hashing, hashes the source again, renames the staging folder into `.versions/<hash>/` (or drops it when that version exists), and switches the Development link with one `rename()`. Saving the same content twice gives the same version.
- Answers: **200** with the hash (or null), the saved files, the skipped paths and the warnings; **422** listing every refused path with its reason, saving nothing; **409** when `template/` changed during the copy, saving nothing.
- There is no read-back route and no mount of Templates into any pod. `GET /agents/:id` carries `template: { hash } | null` per Environment, so the Store and the Builder can tell whether Production is behind Development.
- Files a human brings arrive through the chat's upload bar, and the Builder copies them into `template/`.
- The author can also edit `template/` from the chat's Code tab. With no read-back route, the Builder keeps its own copy of what it last saved (`.cache/template-saved/`, taken after every 200) and compares `template/` with it before every check and save. An author's edit is kept. The Builder asks one question only when an edit contradicts a requirement the brief states or fails the check, and it puts a file the check failed on back from that copy.

## What a save refuses, leaves out and warns about

- **Refused (422):**
  - symlinks
  - the platform's per-Project `app/` files, `app/opsiforce.env.json` and `app/app.meta.json`
  - `.env*` files other than `*.example`, because secrets belong in Environment settings
- **Left out, and listed as skipped:**
  - files opencode would load as instructions, config or Skills beside the Agent's prompt: `AGENTS.md` at any depth, a root `opencode.json` or `opencode.jsonc`, and `.claude/` and `.agents/` at any depth. The prompt stays the only instruction source ([ADR-0061](0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)). They are skipped rather than refused because a cloned repo often carries them, and the child never sees them either way. Files opencode does not load, such as `CLAUDE.md` or `.cursor/`, are saved like any other.
  - platform folders: `.opencode/`, `.opsiforce/`, `.xdg/`, `.git/`
  - dependencies: `node_modules/` and the package manager's cache, unplugged folder, state files and `.pnp.*`
  - any `data/`, and the caches `.cache/`, `.config/`, `.bun/`
  - `user_uploaded_files/`, `generated_files/`, and whatever the Template's own `.gitignore` files exclude
- **Warned, and saved anyway:** key-like strings. The warning lists each suspect so the Builder can tell the author.

Apart from the skipped instruction files, a saved Template is what the Project's git would track: the Template, the Project's first commit and what Publish (App) carries are the same files.

## The lay at Project create

- For a Custom Agent, `deliverAtCreate` lays the Template first, then writes the prompt and Skills, all before the pod exists ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)). It reads the link once, copies that version into a staging folder in the new workspace keeping file modes, checks the copy's hash against the version's name, and moves the entries into the workspace root. On a mismatch it discards the copy, reads the link again and retries, up to three times. The create request waits for the copy.
- The init container then finds `app/` present (or makes an empty one), lays no package template, and its `git init` commits the Template as the first commit, "Initial template". When the Template carries a root `.gitignore`, the init container appends every missing platform line under a `# platform` marker, so a Template cannot un-ignore platform paths.
- A copy error, a hash mismatch after three retries, or a link to a missing version discards the half-made Project and fails the create. A broken link is never read as "no Template".
- The pool, Duplicate (Project), Import (Project) and Publish (App) have no Template step: the pool serves only Built-in Agents, and the other paths copy a workspace that already holds the Template. Duplicate (Agent) and Import (Agent) write a new Agent's first version through save's writer ([ADR-0075](0075-duplicate-and-export-agent-carry-only-development-into-a-new-agent-through-one-writer.md)).

## Which Template a Project gets

- An ordinary Project gets its Agent's Default environment (Agent) Template, prompt, model and Skills.
- A Test Project gets its Agent's Development for all of them, and may be created before the first Publish (Agent), since its live check asks for a Development Profile.
- An Agent chat's Test Project runs only on the chat's subject Agent. A Skill chat still picks any Agent to test its Skill on, and that Test Project reads that Agent's Development.

## Publish, Delete and cleanup

- Publish (Agent) takes the per-Agent lock with `pg_advisory_xact_lock`, writes the Profile rows, and as its last steps before `COMMIT` switches the target's link to Development's version (or removes it when Development has none) and deletes the old version if nothing links to it. A failing link step rolls the rows back. A failed `COMMIT` after the switch is fixed by publishing again, because the no-op check counts the Template. Publish refuses a Development link whose version is missing.
- Delete (Agent) deletes the row, then, once that has committed and under the per-Agent lock, `agent-templates/<agentId>/`. A failed removal does not fail the request. Disable leaves the Template untouched ([ADR-0070](0070-skills-and-agents-are-disabled-per-organization-like-projects.md)).
- The daily workspace-cleanup job also walks `agent-templates/`. It removes folders of deleted Agents, stale staging folders, and versions no link points at, the last under `pg_try_advisory_xact_lock`, because a healthy save's new version has no link for a moment. It logs a link whose version is missing and leaves it, so create keeps failing loudly until someone saves or publishes again.
- The Publish dialog and the Store's drift line show a Template line: Same, Changed, Added, Removed, or hidden when neither side has one. Storage use gets a `templates` bucket, attributed to the Organization through `agents.tenant_id`.

## What goes in a Template

- A Template holds files the Project owns: they enter its git, the child may change them, and Publish (App) ships them. A Skill holds know-how the agent reads when needed and is never copied into a Project. The Agent's body holds its identity and the rules every Project keeps.
- The Builder puts a file in the Template when every Project of the Agent should start with it and the child would otherwise re-create or fetch it each time. When nothing is like that, the Agent has no Template.
- Any `app/startup.sh` in a Template makes it an App under the App contract.
- A Template built on the platform's web-app starter is a full copy the Builder makes and edits. It changes only when the author asks the Builder to bring in later starter changes. `web-app` then checks that `app/` holds the starter and stops if it does not, and `agent-authoring` pins `web-app` only for such a Template. Another stack is a skeleton the Builder writes into the Template and runs itself, and a stack Skill carries know-how only.
- A building Agent's body keeps a short Architecture section of rules to keep. The Template holds the result.

## A Builder chat lives as long as its subject

A Custom Agent's Builder chat holds the draft `template/`, so it is never deleted on its own. It is deleted with its subject.

When an Agent's chat is first made and the Agent has a Development Template, `deliverAtCreate` lays that version into the chat's `template/` the way it lays a Template at Project create, before the pod starts. The chat is created knowing its subject, and a chat that loses the race to claim its subject is discarded with its copy. Without this, the first save in a fresh chat would mirror an empty `template/` and remove a Template the Agent already had, for example one a Duplicate or an Import gave it.

## Considered options

- **The Template as a folder in the Builder chat's workspace, published like an App.** With no history wanted, git adds nothing. A chat ProjectEnvironment with no pod would be picked up by boot recovery, the Agent Updates sweep, Skill fan-out, proxy wake, idle timeout and Environment delete. The definition would also be split between a Profile row and a chat commit.
- **Template bytes in the database, or in object storage.** No Template content goes in the database. The deployment has no object storage, and the volume that already holds every workspace makes the lay a rename on one filesystem.
- **A plain folder for Development, with versions only for Publish targets.** Two code paths, a large copy inside the synchronous Publish request, and half-copied Templates visible to Projects created mid-save.
- **A bare git repository per Agent, one ref per Environment.** It stores each file once, but it is opaque on disk. It stays possible behind the same module if saves of large Templates prove slow.
- **A reference to the starter instead of a snapshot**, laying the image's current starter at create with the Template's files on top. The overlay would run on a starter nobody tested it against, it cannot express a deleted file, the pinned `web-app` would describe different files, and the platform would have to interpret a kind of Template.
- **Laying the Template in the init container.** It needs a second mount, duplicates the link and hash logic in the image script, and a failure shows as a crash-looping pod instead of a refused create.
- **A grace period before an unlinked version is deleted.** The readers' hash check makes immediate deletion safe.
- **Committing the Profile rows first and switching the link afterwards.** A failed switch leaves new rows over an old Template for Projects created meanwhile, and it needs a session-scoped lock.
- **A Template file browser, a download, or a read-back route.** The Publish dialog's Template line and the per-Environment hash tell an author and the Builder what they need. A read-only mount of the Templates into Builder pods waits for a real need.
