---
kind: explanation
terms: [Duplicate (Agent), Export (Agent), Import (Agent), Agent export]
adrs: [0075]
---

# Agent Copies

> How does an Agent become a new Custom Agent, duplicated within one Organization or exported and imported into another?

## How it works

### Duplicate

- [Duplicate (Agent)](../../CONTEXT.md) forks any Agent a member can see — public, Built-in, or their own — into a new private [Custom Agent](../../CONTEXT.md) under a new name, with `POST /agents/:id/duplicate {displayName}` under `can_manage_agents` and no public API route. The copy carries the source's description, `platform_api`, Development prompt body, model and variant, Skill pins (the same Skill and Version ids, `platform` included, which is added at its current Version only when the source pins none) and Development [Template](../../CONTEXT.md), rewritten under the new id with the same hash.
- The copy gets `pool_size` 0, the caller as creator, and Production as its [Default environment (Agent)](../../CONTEXT.md) with no Production Profile, so it reaches the picker after its first Publish. It never carries the [Builder chat](../../CONTEXT.md), a [Test Project](../../CONTEXT.md) or any other Environment, its first Builder chat opens with the inherited Template in `template/`, nothing records what it was copied from, and it is the only way back from a Visibility already made public.
- **From a Built-in source** the copy works from the start: the prompt is the body of the backend's own `agent-config/…/agents/<name>/agent.md` without its frontmatter, the model and variant are the source's merged-registry entry, the Skills are every Skill the package really ships at its current Version plus the Organization's pins on the source, and the first Template is the package `template/`. That template goes through Template save's writer, so the Publish dialog never shows a false Changed for an unedited copy; workspace migrations never travel.
- The Template is written first and every row goes in one transaction: a failed transaction removes the new folder at once, and a crash in between leaves a folder the cleanup job removes ([ADR-0075](../adr/0075-duplicate-and-export-agent-carry-only-development-into-a-new-agent-through-one-writer.md)).

### Export

- [Export (Agent)](../../CONTEXT.md) writes a Custom Agent's Development definition to an [Agent export](../../CONTEXT.md), `<slug>-agent-export.zip`, from `GET /agents/:id/export` under `can_manage_agents` and no public API route. It reads the Agent through the same bundle reader Duplicate uses and carries the same parts: never the Builder chat or a Test Project.
- The zip holds `manifest.json`, `template/**` (the Development version's files, with their modes) and `skills/<name>.zip`, one Skill pack per pinned Custom Skill at its pinned Version, in the format a Skill Version export downloads. The manifest is `{kind: "agent", stamp{exportFormatVersion: 1, platformVersion, agentImageVersion, arch}, agent{displayName, slug, description, platformApi}, profile{promptBody, model, variant}, skills[{name, origin, contentHash, file?}], template{hash} | null}`; a Built-in Skill travels by name and hash alone, with no `file`.
- `GET /agents/:id/export/preview` runs the Skill gate's key-like scan over the Template and each pinned Custom Skill, and the Export dialog, beside Duplicate in the Agent actions menu, lists the hits as a warning that never blocks the download. The dialog says the chat and the Test Project stay here.

### Import

- [Import (Agent)](../../CONTEXT.md) turns an Agent export into a new private Custom Agent owned by the importer, in any Organization or deployment; it never updates an existing Agent. The **Import agent** button beside New agent opens a dialog with a `.zip` picker and an optional name ("Name from the file"); the file goes up through Project Import's chunked upload sessions with progress, then `POST /agents/import {uploadId, displayName?}`, under `can_manage_agents` and `can_manage_skills` and no public API route, answers with the Agent and its `notes[]`.
- Only a manifest with `kind: "agent"` is read; a Project export, with or without `kind`, is refused as 400 `not_an_agent_export`. Of the stamp, only an `exportFormatVersion` newer than the deployment reads is refused (`export_format_unsupported`).
- A read-only resolver checks everything before any write and reports every problem at once. **Built-in Skills**, `platform` included, match by name and hash: the same hash pins that Version, a different one pins the current Version with a note, and a missing name is refused. **Custom Skills** match by name in the importing Organization: an absent one becomes a private Skill of the importer's at Version 1 (`createdVia: 'import'`), a Version with the same content is pinned as it is, different content in a Skill the importer can edit becomes a new Version, and a Skill they can't edit, a disabled one or a reserved Built-in name is refused.
- A **model** the deployment doesn't offer becomes the registry default, with a note. The **Template** is unpacked and run through Template save's filter: a refused path is a problem, a skipped one such as a hand-added `AGENTS.md` is left out and listed in `notes[]`, and the hash of what is kept must equal the manifest's.
- Then the bundle writer Duplicate uses creates the Agent: the Template first, then the Agent rows and the new Skills and Versions in one transaction, so a failure leaves neither. The Agent defaults to Production, reaches the picker after its first Publish, and its first Builder chat opens with the imported Template.
- With notes, the dialog's result state lists them with an Open agent button; with none, it opens the new Agent. The dialog deletes the upload session when it closes ([ADR-0075](../adr/0075-duplicate-and-export-agent-carry-only-development-into-a-new-agent-through-one-writer.md)).

## Edge cases

- When a Duplicate names a taken or reserved slug, it answers 409 `name_unavailable`, which the dialog shows under the name field.
- When a Duplicate's or an Export's source Template is damaged, or its files no longer hash to its name, it is refused as `template_damaged`, so a broken file is never written.
- When the source is the Skill & Agent Builder, Duplicate answers 400 `not_duplicable` and its menu item is hidden.
- When the source is a Built-in Agent, Export answers 400 `not_exportable` and has no menu item: duplicate it, then export the copy.
- When an Import's name is taken, it answers 409 `name_unavailable` with the file's name and every other problem, and the dialog fills the name field and resubmits on the same upload.
- When an Import is refused for anything else, it answers 422 `import_refused` with `problems[]`.

## Code

- `backend/src/agent/agent-bundle.reader.ts` — the in-memory Agent bundle, read from the database and the volume for a Custom Agent and from `agent-config/` for a Built-in one.
- `backend/src/agent/agent-bundle.writer.ts` — the one writer that creates a new Agent for create, Duplicate and Import.
- `backend/src/agent/agent-export.service.ts` — Export (Agent): the manifest, the zip and the key-like preview.
- `backend/src/agent/agent-import.service.ts` — Import (Agent): the manifest and kind check, the read-only resolver, its refusals and notes.
- `frontend/src/pages/store/agent-page.tsx` — the Duplicate and Export dialogs in the Agent actions menu.
- `frontend/src/components/store/import-agent-dialog.tsx` — the Import agent dialog: the upload, the refusals and the notes.

## Related

- [Custom Agents](custom-agents.md) — the Agent a copy becomes, and the Profile and Visibility it starts with.
- [Template](template.md) — the store and the save's writer every copy's Template goes through.
- [Skill](skills.md) — the Versions a pin names and the Skill pack format an export carries.
- [Export and Import](../projects/export-import.md) — the Project sibling and the chunked upload sessions Import (Agent) uses.
