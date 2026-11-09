---
kind: explanation
terms: [App, App Details]
adrs: [0010, 0016]
---

# App

> How does each ProjectEnvironment's App get its name and description, who may change them, and how does the running App learn its own identity?

## How it works

- Every [ProjectEnvironment](../../GLOSSARY.md) runs its own [App](../../GLOSSARY.md) with its own [App Details](../../GLOSSARY.md), so one [Project](../../GLOSSARY.md) groups several Apps ([ADR-0016](../adr/0016-app-details-are-per-environment.md)); the `project_app` row is keyed by environment and each environment writes only its own row.
- Nothing designates one App to stand for the Project: each App is reached directly at its own [Public URL](../../GLOSSARY.md) ([Public URL](public-url.md)).
- The App's source of identity is `app.meta.json` at the project root, holding name and description only; the platform reads that file directly ([App Readiness](app-readiness.md)), and the agent template additionally serves it at `/api/app-meta` for its own tab title.
- At [Go-live](../../GLOSSARY.md) the pod pushes the App's state to the backend, which upserts that environment's row and notifies the open workspace over SSE so the app pane appears ([App Readiness](app-readiness.md)). The report that creates the row also sets the App's [App Slug](../../GLOSSARY.md), the readable start of its Public URL; later reports and name edits leave it alone, and only [Edit URL](../../GLOSSARY.md) changes it.
- Humans re-curate name and description against the [Active environment](../../GLOSSARY.md): the backend rewrites that environment's `app/app.meta.json` atomically, then mirrors the values into its row and publishes an SSE event; an environment with no detected App is refused.
- The rule is latest writer wins: the agent may rewrite the file later, and is instructed to carry an existing name forward verbatim unless asked to rename.
- The App reads its own identity at runtime: the template frontend queries `/api/app-meta` at startup and sets the tab title, and the favicon is a neutral placeholder the agent overwrites at Go-live ([ADR-0010](../adr/0010-app-identity-read-at-runtime.md)).
- Gated by `can_edit_app_details`, which also gates Edit URL ([Permissions](../organization/permissions.md)).
- The App preview's address bar follows the page the App is on: it shows the App's Public URL host, once it has one, beside the current path, query and fragment. Clicking it selects the whole address at that page, as a browser does, to copy or edit and open with Enter. Back and Forward move through the App's own history, Reload and every automatic reload keep the current page, and Copy URL and Open app hand out the Public URL at that page. The pane learns the page from the preview host, which reports every navigation to the platform ([Request Flows](../runtime/request-flows.md)).

## Edge cases

- When a published environment's Details are curated, a later Publish update keeps them: only a first Publish carries Development's `app.meta.json` ([ADR-0107](../adr/0107-a-publish-carries-the-apps-data-only-when-asked-by-mirroring-developments-data-folder-and-replaces-nothing-the-target-owns-unless-chosen.md)).
- When a Project predates the runtime-identity template, its App keeps a hardcoded title until regenerated.
- When the preview shows a page that does not report its location (the proxy's starting page, or an App whose Content-Security-Policy blocks inline scripts), the address bar keeps the last path it knew, Back and Forward stay disabled, and Reload loads that path again.
- When the browser has no Navigation API, Back and Forward stay disabled while the address bar still follows the App.

## Code

- `backend/src/project/app.service.ts` — the per-environment App row upsert, which sets the App Slug when it creates the row.
- `backend/src/project/project.service.ts` — the human edit path that rewrites the metadata file and mirrors it into the row, and the Edit URL path that sets the App Slug.
- `project_app` in `backend/db/schema.ts` — App Details per ProjectEnvironment.
- `frontend/src/components/project/` — the app pane, the edit-details UI and the Edit URL dialog.
- `frontend/src/components/project/preview/preview-address.ts` — the messages the App preview exchanges with the preview host, and reading a typed address.

## Related

- [App Readiness](app-readiness.md) — the push that drives Go-live detection.
- [Public URL](public-url.md) — the App Slug, Edit URL and the addresses an App answers on.
- [File preview](file-preview.md) — the panel the App preview shares with files.
