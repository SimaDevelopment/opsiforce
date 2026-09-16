---
kind: explanation
---

# Job Dock

> How do publish, duplicate, export and import show progress in one place, and how does import's upload fit in?

## How it works

### One surface

- Four long-running operations, [Publish](../projects/publish.md), [Duplication](../projects/duplication.md), [Export and Import](../projects/export-import.md), are backend jobs streaming progress over SSE, and one job dock renders all of them as a stack of cards in the bottom-right corner that expand into a dialog.
- The dock is mounted once at the root layout, so a job started anywhere surfaces in the same place and survives navigation; a small context exposes `trackPublish`, `trackDuplicate`, `trackExport` and `startImportUpload`.
- A card shows title, current step and a progress bar; the dialog shows the full step list; closing the dialog drops back to a card while the job keeps running.
- A finished card carries a kind-specific action: Download for export, Open project for import and duplicate, Open app and View environment for publish; a failed card shows the error and a dismiss button.
- Everything kind-specific lives in a per-kind adapter (phase and step reading, the SSE endpoint, titles, byte progress, terminal actions, queries to invalidate); the host, card and dialog are generic, and a fifth kind is one adapter.
- Jobs are keyed `kind:id`, publish by environment and the rest by [Project](../../CONTEXT.md), so a publish and an export for one Project sit side by side.
- The dock's state is in-memory; a reload clears the cards while the jobs run to completion on the backend.
- The project page registers two publish callbacks with the dock while mounted, reloading the preview and switching the [Active environment](../../CONTEXT.md) in place, and the adapter falls back to navigation when they are absent.

### Import owns its upload

- Import's work starts before a backend job exists: the dock runs the chunked upload itself from a runner module behind a start, retry and cancel seam, keyed `import:<uploadId>` since no Project id exists yet, then finalizes and the same card carries into the server-side phases.
- Progress comes from an XHR loop, because `upload.onprogress` is the only cross-browser source of sent-byte counts; transient chunk failures retry with backoff before the card flips to interrupted.
- "Upload interrupted" means the bytes never all arrived and Retry resumes from the last confirmed chunk; "Import failed" means the server has the bytes and refused them.

## Edge cases

- When a finalize is rejected with 400, or finds the session swept or cancelled (404), the card is dismiss-only; any other finalize failure keeps the staged bytes and Retry re-posts finalize, while dismissing such a card deletes the kept session.
- When a card is dismissed mid-upload, the in-flight request aborts and the server is told to drop the staging directory.
- When the tab is closed with recoverable pre-enqueue work in flight, a `beforeunload` confirm guards it; a reload abandons the upload.

## Code

- `frontend/src/components/project/jobs/` — the host, card, dialog and per-kind adapters.
- `frontend/src/components/project/jobs/import-upload-runner.ts` — the upload transfer machinery.

## Related

- [Publish](../projects/publish.md) — the stages the publish adapter renders.
- [Duplication](../projects/duplication.md) — the steps the duplicate adapter renders.
- [Export and Import](../projects/export-import.md) — the export job and the chunked upload protocol.
