---
kind: explanation
terms: [File preview, Document conversion]
adrs: [0048, 0049]
---

# File preview

> How does a member read a file the Agent produced in the side panel, what renders there, and what keeps inline serving safe?

## How it works

### The panel

- [File preview](../../CONTEXT.md) shares the right side panel with the App preview; a centered App | File switcher appears in its header when both exist, and closing the file returns to the App or hides the panel when there is no App.
- The App iframe is never unmounted while a file shows; it is hidden with `display: none`, so the App's in-progress state survives the detour ([App](app.md)).
- The panel is keyed on each request to show a file, so clicking the same file again after switching back to the App reopens it.
- A preview is single-file: opening another replaces it, and switching the [Active environment](../../CONTEXT.md) closes it.

### Two ways in

- A preview opens from a chat link or from the [Files](files.md) tab; both hand the same workspace-relative path to the same panel.
- Links into [Generated files](../../CONTEXT.md) are promoted to file cards (type badge, link text, download button) by decorating the anchor and appending one download element; a mutation observer re-applies the decoration after each re-render of the embedded OpenCode chat, idempotently ([Document Generation](../agent-system/document-generation.md), [File Downloads](file-downloads.md)).
- Any other `/workspace/...` link gains preview-on-click for supported formats and otherwise downloads as before.

### What renders

- PDFs render in the browser's viewer, images and SVG through `img`, and text, code and markdown through the chat's markdown pipeline and highlighter; SVG is only ever an image source, never inlined.
- Text is a candidate by extension only: the first 8 KB are checked for a NUL byte and a binary file falls back to the download card; very large text is truncated with a visible note.
- HTML renders live with scripts in a frame carrying `sandbox="allow-scripts"` and never `allow-same-origin`; CSV parses into a table and an xlsx workbook into a read-only values grid with a sheet selector, both bounded to the first 500 rows and 200 columns with a footer stating the cut.
- Word and PowerPoint go through [Document conversion](../../CONTEXT.md): a job endpoint returns an id, the panel polls, and a third endpoint streams the resulting PDF from the in-cluster Gotenberg converter ([ADR-0048](../adr/0048-office-documents-are-converted-in-cluster-by-gotenberg.md)); results are transient and never cached.

### The content endpoint

- Reading and saving are different endpoints: download is attachment-only, the content endpoint serves inline for an allow-list (PDF, raster images, inert text, HTML) and everything else as attachment ([ADR-0049](../adr/0049-inline-content-endpoint-security-posture.md)).
- Every HTML response carries a `Content-Security-Policy` that sandboxes the document and sets `default-src 'none'`, leaving inline script, inline style and `data:` or `blob:` images, so a report can draw its own charts but cannot reach the platform API, cookies or the parent page.
- The endpoint sends the correct content type, `nosniff`, `no-store` and Range support, and shares download's path guards and membership check; it reads the shared volume, so a preview never wakes the Agent's pod.

## Edge cases

- The panel changes mode only on a click: opening a preview, using the switcher, or closing the file; the Agent finishing a file never switches it.
- When the previewed file is deleted, or a folder above it, the preview closes.
- When a format is outside the matrix, the panel shows a download card; a chat link to an unsupported format downloads as before.
- When a linked file has since been deleted or renamed, the panel says "file not found".
- When the converter refuses a document, the card offers download with no retry; a converter fault or a busy converter offers Try again.
- When the backend restarts during a conversion, the in-memory job is lost and surfaces as retryable.
- PDFs render in an un-sandboxed frame, since a sandboxed frame renders nothing; both frames fire `load`, so the load event is no signal when re-testing.

## Code

- `backend/src/files/content.controller.ts` — inline serving, the disposition allow-list and the HTML policy.
- `backend/src/files/convert.controller.ts` — the conversion job, status and result endpoints.
- `backend/src/files/gotenberg.service.ts` — the in-cluster converter call and outcome mapping.
- `helm/opsiforce-gotenberg/` — the converter deployment.
- `frontend/src/components/project/preview/` — the panel, the switcher and the format renderers.
- `frontend/src/components/project/workspace-file-links.tsx` — chat link decoration and the click interceptor.

## Related

- [File Downloads](file-downloads.md) — the link convention this extends and the attachment-only endpoint.
- [Files](files.md) — the other door into the panel.
- [Document Generation](../agent-system/document-generation.md) — how the Agent produces the deliverables.
- [App](app.md) — the App preview that shares the panel.
- [Deployment](../operations/deployment.md) — where the converter sits in the deploy chain.
