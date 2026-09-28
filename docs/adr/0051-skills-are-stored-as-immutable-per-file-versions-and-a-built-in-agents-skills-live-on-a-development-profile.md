# Skills are stored as immutable per-file Versions, and a Built-in Agent's Skills live on a Development profile

A Skill is a directory (`SKILL.md` plus optional `scripts/`, `references/`, `assets/`) that the Store renders, the validation gate walks, diffs compare and delivery lays into a workspace. It has to work in the standalone build with only Postgres and the backend, and an Agent pins exactly one frozen copy of it.

**The catalog is three tables, `skills`, `skill_versions` and `skill_version_files`, and every save validates the tree and mints the next immutable Version. There is no draft tier. A Built-in Agent's Skills sit on one Agent Profile per Organization, parked at that Organization's Development environment.** Concretely:

- **One catalog for both origins.** Built-in Skills are reconciled from the image at boot as global rows: `origin = 'built_in'` and `tenant_id` NULL. A Custom Skill has `origin = 'custom'` and must carry `tenant_id` and `created_by`, under a CHECK. A Built-in Skill that leaves the image is marked unavailable, and its stored Versions stay so Agents that pinned it keep working.
- **The name is fixed and unique.** `name` is the frontmatter identity and the directory the Skill is delivered into. It is set at creation and never changes: only the display name is editable, and every Version's `SKILL.md` must carry the same name. It is unique across the Organization's Skills and the global rows, and names the image ships are reserved. opencode's skill namespace is flat, so two Skills of one name would resolve unpredictably.
- **A name is also unique within one Agent's Skills.** Adding a second Skill of the same name is refused with the conflict named, because opencode keeps only one of two same-named skills while the UI would list both.
- **Content is one row per file.** `skill_version_files` holds path, content, size, a binary flag and an executable bit. The `.skill` zip exists only at the import and export boundary.
- **Saving is publishing.** The Builder chat or the Store form holds work in progress. Submitting runs the gate; a failing tree is refused with every error and lint, and nothing is stored. A passing tree becomes the next integer Version, and `skills.latest_version_id` moves in the same transaction.
- **A Skill may have no Version yet.** Naming a Skill before its Builder chat has written it creates the row alone. Nothing can pin it until a Version exists, and it can be deleted without being disabled first. A Skill that has a Version is disabled before it is deleted.
- **Delete is refused while any Agent carries the Skill**, and the refusal names those Agents. Deleting a Skill removes its Versions and its Builder chat.
- **Every Version records its provenance**: `created_via` (the path that minted it), `source_ref` (an upstream reference from an import's manifest), `created_by` and a content hash, beside its description, `flags` (`has_executables`) and lint names. Versions are never changed or pruned.
- **The gate runs offline.** Errors block: the manifest and frontmatter rules, name format and reserved names, symlinks, unsafe paths, size and file-count limits, invisible Unicode, and secret-token formats. Angle brackets in `description` are an error as a security control: opencode interpolates a skill's name and description unescaped into the system prompt. Lints only warn: body length, a short description, unresolved or too-deep links, and `allowed-tools`, which is stripped because permissions live in the platform-owned `opencode.json`.
- **"Update available" reads `latest_version_id`.** An Agent's Skill shows it when its pinned `skill_version_id` differs. Nothing upgrades on its own: re-pinning is an explicit act on one `(agent, skill)` pair, and there is no bulk upgrade.
- **A Built-in Agent's Skills sit on an `agent_profiles` row per Organization at the Environment with `is_default = true`**, which is Development. The row is created the first time that Agent's Skills are read or changed in the Organization, so nothing is backfilled. Its `prompt_body`, `model` and `variant` are NULL, because a Built-in Agent's content is the image's. Its Skills apply on every Environment and reach the Organization's existing Projects at delivery; the Environment is where the row is parked, not what it scopes.
- **Guards keep the built-in row where it is.** Publish (Agent) is refused for a Built-in Agent. The add and remove paths resolve Development themselves and never take an Environment from the caller. Only `EnvironmentService.ensureDefaultForTenant` sets `environments.is_default`.
- **Export is open to any member who can see the Skill**; import needs `can_manage_skills`. Export exposes nothing the Store and the Project workspace do not already show.
- **Duplicate (Skill)** creates a new private Skill whose first Version copies the source's latest files under the new name, and records nothing about where it came from.
- **The API never names a profile.** `GET /agents/:id/skills`, `PUT /agents/:id/skills/:skillId` (add or re-pin) and `DELETE /agents/:id/skills/:skillId` route to the Development profile for either kind of Agent. An Environment appears only where it is a real choice, in `POST /agents/:id/publish`.

## Considered options

- **One zip or tar blob per Version**: rejected. Every read path (Store page, gate, diff, delivery) would unpack an archive, while writes are rare.
- **Files on the shared volume with metadata in the DB**: rejected. It splits the catalog across two systems with different transaction and backup semantics, and complicates standalone.
- **One polymorphic config-object table for Skills and Agents**: rejected. The two kinds have different consumers, and a generic table collides with the existing `agents` table, reconciler and pool.
- **A single mutable draft slot per Skill**: rejected. It adds a mutable write beside immutable Versions, and a second place for work in progress that would disagree with the Builder chat.
- **Seeding Built-in Agent prompts into the DB**: rejected. A copy of content git already owns is the two-sources-of-truth failure [ADR-0008](0008-agent-model-owned-by-agent-config.md) removed.
- **Renameable Skills**: rejected. A rename changes the flat namespace every Agent's skill list is built from.
- **An `external_urls` flag**: rejected. A regex over text files misses URLs assembled at runtime and skips binaries, and nothing limits a pod's egress, so an empty list would read as a safety promise the platform does not make.
- **Two tables for an Agent's Skills**, a profile child for Custom Agents and an Organization table for Built-in ones: rejected. The row, the API and the UI are identical.
- **A nullable `environment_id` plus `tenant_id` on `agent_profiles`** to say "not scoped to an Environment": rejected. Every Custom Agent query would have to exclude the NULL, and the tenant would have three sources of truth, to guard against a default Environment that nothing can change.
- **Backfilling built-in profiles**: rejected. It writes an empty row per Organization and Built-in Agent that carries no information.
- **An `owner_agent_id` for Skills that belong to one Agent**: rejected. It buys hiding a Skill that only its creator can see anyway, at the price of a second lifecycle. A private Skill plus the downward coherence rule of [ADR-0057](0057-authored-skills-and-agents-are-private-or-public-within-one-organization.md) gives the same effect.

## Consequences

- The Store, the gate, diffs and delivery are plain queries, with no unzip step in any read path.
- Version retention is unbounded; no pruning code exists.
- Unfinished Skill work lives only in the Builder chat ([ADR-0064](0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)), so deleting the chat loses it.
- Each Version is a person saying the Skill is ready, so "update available" never fires mid-edit.
- Making `environments.is_default` settable would strand every Built-in Agent's Skills at the old Environment. Any such change must move the built-in profiles with it.
- A Built-in Agent has at most one `agent_profiles` row per Organization, always at the default Environment. The repository layer enforces this, as it does "only the Development row is edited" for Custom Agents ([ADR-0058](0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)).
