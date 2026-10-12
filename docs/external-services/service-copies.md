---
kind: explanation
terms: [Duplicate (External Service), Export (External Service), Import (External Service), Service export]
adrs: [0090]
---

# Service copies

> How does an Organization admin duplicate a Custom External Service, export it to a file, and import that file as a new service?

## How it works

### What a copy carries

- A copy is Development's last committed `app/` folder: the [Custom External Service](../../GLOSSARY.md)'s builder workspace is read at `HEAD`, so work its builder has not committed is left out, and the dialogs say so ([ADR-0090](../adr/0090-a-service-copy-is-always-a-new-draft-made-from-developments-committed-app-folder-and-carries-no-configuration.md)).
- Yarn caches, Plug'n'Play files, `node_modules` and macOS `._` and `__MACOSX` entries never travel, even when committed. No [Service configuration](../../GLOSSARY.md), Project configuration, secret, `ctx.state`, Call, chat history, Test Project or test report travels.
- Every copy is a new Draft with its own builder chat, named and slugged by the admin under the slug rules of New External Service; it never updates an existing service. The admin then fills its Service configuration, tests it and publishes it as any Draft ([External Service Builder](external-service-builder.md)).
- The files are written into the new builder chat's workspace before its pod lays the template, so the pod keeps them and commits them as its first commit. A workspace taken from the pre-warmed pool already holds the template: its tracked `app/` files are removed, the copy is written and committed on top. Either way the copy's commit reads "Copied from <source service name>" (Duplicate) or "Imported from <file name>" (Import).

### Duplicate and Export

- The service page's actions menu offers **Duplicate** and **Export** for a Custom External Service to holders of `can_manage_tenant_external_services`; built-ins offer neither, and their routes answer 404.
- **Duplicate** (`POST /api/external-services/services/<id>/duplicate {name, slug}`) creates the copy in the same Organization and opens its builder chat.
- **Export** first shows `GET …/services/<id>/export/preview`, which lists key-like text in the copied files as a warning and never blocks, then downloads `GET …/services/<id>/export` as `<slug>-service-export.zip`.
- The [Service export](../../GLOSSARY.md) holds `manifest.json` (kind `external-service`, export format version, platform, agent image and SDK versions, the service's name and slug) and the files under `app/`.
- A service whose builder has committed nothing answers `409 nothing-committed` to both.

### Import

- **Import service**, beside New External Service on the External Services list, uploads the file through the chunked upload sessions [Export & Import](../projects/export-import.md) uses, then `POST …/services/import {uploadId, fileName?, name?, slug?}` creates the copy, named and slugged as the file says unless the admin chose otherwise; `fileName` (the uploaded file's name, else `<slug>-service-export.zip`) labels its commit.
- A taken or reserved slug answers `409 slug-taken` with the file's name and slug; the upload is kept, so the dialog resubmits it under a new slug without uploading again.
- Only entries under `app/` are written, each confined to the new folder; a symlink or a path that leaves it refuses the whole import with `422 import_refused`, and nothing is created.
- A file without `app/service.json`, of another export kind or with a newer export format version answers 400 (`not_a_service_export`, `export_format_unsupported`); Agent and Project import refuse a Service export the same way.
- A vendored SDK of a major this deployment does not serve, or a folder failing `check`, still imports as a Draft with a warning that the builder must fix it; Publish's `check` refuses it until then.

## Code

- `backend/src/external-services/custom/service-copies.ts` — reading the committed folder, the Service export, Duplicate and Import.
- `backend/src/external-services/custom/service-app-seeder.ts` — writing the copied folder into the new builder workspace.
- `backend/src/export/` — the export stamp, export kinds and the archive writer shared with Agent and Project exports.
- `backend/src/git/git.service.ts` — reading a folder's committed files.
- `frontend/src/components/external-service/service-copy-dialogs.tsx` — the Duplicate, Export and Import service dialogs.

## Related

- [External Service Builder](external-service-builder.md) — the builder chat, Development and Publish a copy goes through.
- [Agent copies](../agent-system/agent-copies.md) — the same contract for Custom Agents.
- [Export & Import](../projects/export-import.md) — the upload sessions an import uses.
