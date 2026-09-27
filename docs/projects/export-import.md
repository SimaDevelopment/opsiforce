---
kind: explanation
terms: [Export, Import, Project export]
adrs: [0017]
---

# Export and Import

> How is a [Project](../../CONTEXT.md) carried to a different Opsiforce deployment as a file, and how does the file get there safely?

## How it works

### What crosses

- An [Export](../../CONTEXT.md) seals a Project's [Development](../../CONTEXT.md) working state into a [Project export](../../CONTEXT.md); an [Import](../../CONTEXT.md) creates a new independent Project from one, with fresh keys and paused Schedules like a [Duplicate](duplication.md) ([ADR-0017](../adr/0017-project-export-is-a-faithful-full-workspace-zip.md)).
- The zip holds the workspace files, including full git history, the agent conversation, databases, uploads, the [Environment Variables](../../CONTEXT.md) file with values and the installed dependency store, plus a manifest of database-row state: title, description, settings, [App Details](../../CONTEXT.md), [Schedules](../../CONTEXT.md), and the [Resources](../../CONTEXT.md) class.
- The manifest says `kind: "project"`, so a Project export is never taken for an [Agent export](../../CONTEXT.md), which says `kind: "agent"`; a manifest without `kind`, from an older archive, is a Project export.
- The manifest carries the [Agent](../../CONTEXT.md) as `{slug, displayName, origin, package}`. Import resolves the slug within the target Organization's reach — the global [Built-in Agent](../../CONTEXT.md) of that name, or its own [Custom Agent](../../CONTEXT.md); another Organization's Custom Agent of the same name is not a match. A slug the target does not have links the default Built-in Agent, because `projects.agent_id` is NOT NULL, and records the original slug in `projects.imported_agent`, which the Project header shows as "Imported agent: `<slug>` (not in this organization)" and which the runtime then runs the Project under — so identity keeps matching the prompt file the archive carried ([ADR-0060](../adr/0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)). Import binds the new environment to the target's Development and re-resolves the Resources class on the target's hardware, carrying explicit CPU and memory only for Custom.
- Set on arrival: identity, tenant and Workspace; LLM and service-gateway keys; the timezone, with Schedules re-stamped to it; and the [Auth mode](../../CONTEXT.md), which resets to public.

### Export

- An asynchronous job commits and clones the Development workspace with full history, zips it with the manifest, streams step progress into the [Job Dock](../frontend/job-dock.md), and offers the artifact as a download; it reads shared storage directly, so it runs while the pod is asleep.
- The artifact is single-use: a successful download deletes the file and its job row, and every Export rebuilds from scratch.
- Gated by `can_export_project`, since the file carries live variable values and the full conversation in the clear.

### Import

- Import rehydrates the manifest into fresh rows, unpacks the files into the new Project's directory and boots it through the Duplicate path; the image-owned half of `.opencode/` re-syncs from the target's own agent image on first boot, while the Agent prompt and Skills the archive carried stay as they were.
- The archive is untrusted: writes are confined to the new directory, escaping symlinks are rejected, and a failed or interrupted Import removes the half-created Project, directory and keys.
- The file arrives as an upload session of 8 MiB chunks (`IMPORT_CHUNK_SIZE`, server-returned), each a short `PUT` carrying its own SHA-256 and renamed into place only when length and digest match, so no request outlives the edge's 60-second read timeout and replicas need no coordination.
- Finalize claims the session by renaming its staging directory, so exactly one finalize wins; it verifies the parts are contiguous and full-sized, concatenates them into the regular Import path, and the zip's own CRC32s are the final check.
- Finalize refuses a manifest whose `kind` is anything but `project`, such as an Agent export, with 400.
- Finalize is gated by `can_import_project`. The upload-session routes accept `can_import_project` or `can_manage_agents`, because [Import (Agent)](../agent-system/agent-copies.md) uploads through them too ([Permissions](../organization/permissions.md)).

## Edge cases

- When finalize answers 400, the staged bytes can never import and are deleted; any other failure releases the claim so finalize can be retried without re-uploading.
- When a second finalize hits the same session, it finds nothing to claim and gets 404, so one upload never yields two Projects.
- Abandoned upload sessions and orphaned claims are swept after 24 hours; abandoned export artifacts after `EXPORT_RETENTION_MINUTES` (default five hours).
- When the source and target agent images differ in architecture, Import fails on the copied native binaries; the manifest's platform stamp is recorded but not checked.
- An Import always creates a new Project; a Project export cannot update an existing one.
- URLs or ids the App baked into its own config are not rewritten and need the Environment Variables editor ([Publish](publish.md)).

## Code

- `backend/src/export/` — the export job, artifact hand-over and retention sweep.
- `backend/src/project/project-import.processor.ts` — manifest rehydration, confined unpack and boot.
- `backend/src/project/project-import-upload.service.ts` — upload sessions, chunk verification, claim and assembly.
- `backend/src/git/` — commit and clone with full history.
- `frontend/src/lib/upload/` — the chunked upload client shared with other upload surfaces.

## Related

- [Duplication](duplication.md) — the same-deployment sibling this generalises.
- [Publish](publish.md) — how an imported Project reaches the target's Production.
- [Job Dock](../frontend/job-dock.md) — export and import progress cards.
