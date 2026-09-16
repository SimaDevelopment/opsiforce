---
kind: explanation
terms: [Files, User uploads, Generated files]
---

# Files

> What does the Files tab show of an environment's workspace, what does it hide, and how do uploads and deletes behave?

## How it works

### Three sections

- [Files](../../CONTEXT.md) lists the [Active environment](../../CONTEXT.md)'s workspace as three server-curated sections: [Generated files](../../CONTEXT.md), where the Agent saves deliverables ([Document Generation](../agent-system/document-generation.md)); [User uploads](../../CONTEXT.md), where uploads land; and other files, the strays at the workspace root.
- The App's `app/`, the platform's `data/` and `node_modules/`, and every dotfile are filtered server-side; drill-down 404s on them, the policy is re-applied to the resolved path, and symlinks are dropped from listings.
- Dotfiles are refused on every endpoint, listing, drill-down, content and download alike, and the ban survives symlinks. Hidden roots are a curation rule only: content and download still serve a path under `app/` when asked, because chat links the Agent wrote point there ([File Downloads](file-downloads.md)).
- Navigation is Drive-shaped: pill tabs per section, folder drill-down with breadcrumbs, a table or card toggle remembered across reloads; Generated files opens first.
- Clicking a file opens it in [File preview](file-preview.md); download stays a separate button on every row and in the preview header.

### Adding and removing

- The tab carries an always-visible dashed dropzone strip and accepts drops anywhere; clicking the strip picks files, a Folder button picks a directory with its structure, and a dropped folder is walked from the browser's directory entries so its layout arrives intact.
- Uploads land in the folder being browsed when that folder is inside User uploads, otherwise in the User uploads root; the strip and the drop overlay name the destination.
- The server resolves the requested target inside the workspace and requires it to sit inside User uploads and to be a real directory not reached through a symlink; the upload endpoint is otherwise unchanged, uncapped and permissive about dotfile names.
- The composer's upload strip and the tab's dropzone share one upload engine (streamed multipart, per-file progress, XHR fallback, cancellation, NDJSON summary); a composer upload appends an "Uploaded files:" line to the prompt draft, a tab upload only refreshes the listing.
- Delete is hard, immediate and recursive behind a confirmation dialog, scoped to paths that resolve inside the three visible roots, so the App source, platform data and dotfiles are undeletable by the same rule that hides them.

### Freshness and access

- The listing refetches when the chat embed's debounced agent-idle signal fires and when the member returns to the tab; nothing polls or watches the filesystem.
- Listing, upload, download and delete are backend filesystem work on the shared volume and work while the pod is suspended ([Persistence](../runtime/persistence.md)); upload, download and delete touch environment activity, the listing does not.
- Visible to every project member with no permission gate, behind the same tenant guard and project-membership check download uses.

## Edge cases

- When the file being previewed is deleted, or a folder above it, the preview closes at once.
- When Generated files does not exist yet, the section shows empty; the folder is created on the Agent's first write.
- When a listed name is a symlink, it is omitted from the listing.

## Code

- `backend/src/files/` — listing and curation, upload target validation, delete scope, shared path guards.
- `frontend/src/components/project/files/` — the tab, sections, dropzone and delete dialog.
- `frontend/src/lib/upload/` — the upload engine shared with the composer.

## Related

- [File Downloads](file-downloads.md) — the link convention and download endpoint the tab reuses.
- [File preview](file-preview.md) — the panel a click opens.
- [Document Generation](../agent-system/document-generation.md) — how the Agent fills Generated files.
- [Request Flows](../runtime/request-flows.md) — the upload path and why file paths never wake a pod.
