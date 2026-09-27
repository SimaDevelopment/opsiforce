# Duplicate and Export (Agent) carry only an Agent's Development into a new Agent, through one writer

An Organization copies an Agent to re-brand it or build on it, and moves a Custom Agent to another Organization or deployment, for example from a development deployment to production. Both copy the same parts, so they share one reader and one writer, and the transport is the only difference: a request inside one Organization, or a file across.

**Duplicate (Agent) and Export/Import (Agent) carry an Agent's Development definition and Template, and nothing else, into a new private Custom Agent. The Builder chat and the Test Project never travel. A copy never updates an existing Agent, and nothing records where it came from ([ADR-0058](0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)).**

## What travels

| Part | In the new Agent |
|---|---|
| Display name | the name typed by whoever copies it; the slug is derived from it again |
| Description, `platform_api` | copied |
| Development Profile: prompt body, model, variant | copied |
| Skill pins (Skill and Version) | copied, resolved in the target, `platform` like any other; `platform` is added at its current Version only when the source pins none |
| Development Template | written again under `agent-templates/<newId>/`, with the same content hash |
| Builder chat, Test Project | never; the first open claims a fresh chat, and the first test creates the Test Project |
| Default environment (Agent) | Production, with no Production Profile |
| Visibility, Disable state, `pool_size`, `created_by`, other Environments | private, enabled, 0, the person copying, none |

- The new Agent is the same as one made with New agent. It reaches the Agent picker after its first Publish (Agent), and nothing here publishes.
- Its first Builder chat opens with the Template already in `template/` ([ADR-0073](0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)).
- A source whose Development Template fails its hash check is refused, as Publish (Agent) refuses one.
- A public source halfway through an edit gives a copy of the half edit.

## A Built-in source

Duplicate accepts App Builder and Makara App Builder. The copy is a Custom Agent on the `custom` package.

- **Prompt:** the body of the image's `agents/<name>/agent.md`, without its frontmatter.
- **Model and variant:** the source's entry in the merged registry (`agents.json`, `private/agents.json`), not the registry default.
- **Skills:** a pin on every Skill the package really ships, at each Skill's current Version. That is the shared skills minus `PACKAGE_SHARED_SKILL_EXCLUSIONS`, plus the package's own `skills/`, as `compose-skills.mjs` composes them. The Organization's Development pins on the source are added. Every one of them has a Store row, because the reconciler mints the union of all skill folders.
- **Template:** the package `template/` is saved through the Template save writer, so the first version is what saving an unedited draft gives, and the Publish dialog never shows a false Changed. A unit test runs both shipped starters through the writer and expects zero refusals. The backend reads its own image's `agent-config/`.
- **Workspace migrations** never travel.
- **The Skill & Agent Builder is refused** with 400 `not_duplicable`, and its menu item is hidden. Every Builder chat runs on the real Builder, so a copy could only run in an ordinary Project, where it has no subject and cannot make a Test Project. It would also open an authoring path outside any chat, and its Skills would freeze. House-style Skills go on the real Builder's per-Organization Profile.

## One reader, one resolver, one writer

- The **reader** builds the parts in the table, from the database and the volume for a Custom Agent, or from the image for a Built-in one.
- The **resolver** turns Skill references into target ids. Duplicate's resolver keeps the ids, so private Custom Skills and Skill Versions stay pinned as they are. Import's resolves by name.
- The **writer** creates the Agent. The new id is chosen first. The Template goes through Template save's writer into a staging folder under `agent-templates/<newId>/`, is hash-checked, renamed, and linked as Development. Then every row goes in one transaction: the Agent, its settings, its Development Profile and its Skill pins, plus any Skill or Version that Import creates. A failed transaction removes the folder at once. A crash in between leaves a folder of a missing Agent, which the daily cleanup removes. No reader ever sees a half-made copy.

## Duplicate (Agent)

- `POST /agents/:id/duplicate {displayName}` is one synchronous request under `can_manage_agents`, for any Agent the caller can see. Anyone who can see a Custom source can already edit it.
- A reserved Built-in slug or a slug already taken answers 409 `name_unavailable`, which the dialog shows under the name field with the slug named.
- The dialog is `CreateEntryDialog`'s name field with its live slug, one line on what is copied, and a footer saying the copy reaches the picker after its first Publish. It has no checklist and no warnings, because the copy is private and its maker could already see the source.

## Export and Import (Agent)

**Only Custom Agents are exported.** A Built-in Agent answers 400 `not_exportable`, and its menu item is hidden. Every deployment already has it; a changed one is duplicated first and the copy exported.

**The Agent export** is `<slug>-agent-export.zip`:

```
manifest.json      { kind: "agent",
                     stamp{exportFormatVersion: 1, platformVersion, agentImageVersion, arch},
                     agent{displayName, slug, description, platformApi},
                     profile{promptBody, model, variant},
                     skills[{name, origin: built_in|custom, contentHash, file?: "skills/<name>.zip"}],
                     template{hash} | null }
template/**        the Development version tree
skills/<name>.zip  packSkill output, one per pinned Custom Skill, its pinned Version only
```

- `kind` tells the two export files apart. A Project export's manifest carries `kind: "project"`, and a manifest without `kind` is read as a Project export. Neither Import accepts the other's file.
- Import refuses only an `exportFormatVersion` newer than the deployment reads. The other stamp fields are written and not checked: the file holds no dependencies or binaries, because Template save leaves them out.

**Import always creates a new private Custom Agent**, named by the importer or taken from the file. Before anything is written, a read-only resolution checks the name, the model, every Skill and the Template, and answers with every refusal at once.

- **Template:** runs through Template save's writer, so a hand-edited file cannot slip in an `AGENTS.md`, an `opencode.json` or a `.env`. Its hash must equal `template.hash`, or the file is refused as damaged.
- **Built-in Skills** travel as name and content hash, with no files. The reconciler mints Versions by hash and keeps old ones, so the same content has the same hash on every deployment.
  - The hash exists: that Version is pinned.
  - The name exists but not the hash: the current Version is pinned, with a note.
  - The name is missing: refused, naming the Skill.
- **Custom Skills** travel as files and match by `name` in the importing Organization.
  - Absent: a new private Skill of the importer's, at Version 1, `createdVia: 'import'`.
  - A Version with the same hash exists: that Version is pinned and nothing is added.
  - Different content, and the importer may edit it: a Version is added and pinned. Other Agents keep their pins and see Update available.
  - Not editable, disabled, or a reserved Built-in name: refused, naming the Skill. There is no rename, because the prompt refers to the Skill by its frontmatter `name`.
  - A pinned private Skill can only be the author's own, so carrying it leaks nothing.
- **Model:** a model the deployment's catalog does not offer falls back to its registry default, with a note. The Publish (Agent) diff then shows Model as Changed.

**Transport and UI.**
- Export is `GET /agents/:id/export`, a synchronous download. `GET /agents/:id/export/preview` returns Template save's key-like-string hits for the Template and the Custom Skills, which the Export dialog shows as a warning that never blocks.
- Import uploads through Project Import's chunked upload sessions, then calls `POST /agents/import {uploadId, displayName?}`, which creates the Agent and answers with it and its notes. Chunks keep a Template full of documents working behind the ingress.
- The **Import agent** button sits beside New agent in the Store. On a 409 the name field fills with the file's name and the same upload is reused. Notes show in a result state with an Open agent button; with none, it opens the new Agent.

**Permissions.** Export needs `can_manage_agents`. Import needs `can_manage_agents` and `can_manage_skills`, because it may create Custom Skills or give them Versions. The upload routes accept `can_import_project` or `can_manage_agents`.

**No public API route** exists for Duplicate, Export or Import (Agent). Duplicate is a person naming a copy in the Store, and Download in one deployment and Import in the other covers the development-to-production move.

## Considered options

- **Carrying the Builder chat as an optional checklist row.** Everything a chat holds either travels anyway (the saved Template, the Profile, the Skills) or is worth little in a copy: unsaved drafts, uploads the Template does not use, and a conversation about the old brief that pulls the Builder toward the old intent and Test Project. Carrying it needed a checklist, lifting Project Duplicate's refusal for chats, a job and a secrets warning.
- **Duplicate as a literal export and import in memory.** It loses same-Organization Skill ids and private Skills, and zips what a folder copy does.
- **Separate code paths for Duplicate and Export.** The two would drift in what they carry.
- **Sharing a Custom source's version folder across Agents by hash.** Template deletion counts links within one Agent's folder, and a shared version would need counts across Agents.
- **A job with a Job Dock card.** Nothing slow is copied: the Template is a copy on one filesystem, and no workspace travels.
- **Import updating an existing Agent of the same name.** Nothing records where an Agent came from, so a match by name could overwrite an unrelated Agent's Development.
- **Exporting Built-in Agents.** Every deployment already ships them.
- **Checking the whole stamp.** The stamp gates CPU-bound binaries, and the file carries none.
- **Renaming a Custom Skill that collides on import.** The prompt names the Skill it relies on.
- **Skill import's single request for the upload.** It reads the whole tree into memory under a size cap that a Template of documents exceeds.

## Consequences

- A Custom copy stores its Template bytes a second time.
- A Built-in copy's Template comes from the backend's `agent-config/`, which can be a patch behind the agent image. It is a snapshot either way.
- Importing a Custom Skill whose name exists gives that Skill a new Version, and every other Agent that pins it sees Update available.
- An imported Agent can run on different Built-in Skill Versions, or another model, than its source did. The import's notes say so.
