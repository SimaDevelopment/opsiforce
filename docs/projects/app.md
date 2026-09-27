---
kind: explanation
terms: [App, App Details]
adrs: [0010, 0016]
---

# App

> How does each ProjectEnvironment's App get its name and description, who may change them, and how does the running App learn its own identity?

## How it works

- Every [ProjectEnvironment](../../CONTEXT.md) runs its own [App](../../CONTEXT.md) with its own [App Details](../../CONTEXT.md), so one [Project](../../CONTEXT.md) groups several Apps ([ADR-0016](../adr/0016-app-details-are-per-environment.md)); the `project_app` row is keyed by environment and each environment writes only its own row.
- Nothing designates one App to stand for the Project: each App is reached directly at its environment's URL ([Environments](environments.md)).
- The App's source of identity is `app.meta.json` at the project root, holding name and description only; the platform reads that file directly ([App Readiness](app-readiness.md)), and the agent template additionally serves it at `/api/app-meta` for its own tab title.
- At [Go-live](../../CONTEXT.md) the pod pushes the App's state to the backend, which upserts that environment's row and notifies the open workspace over SSE so the app pane appears ([App Readiness](app-readiness.md)).
- Humans re-curate name and description against the [Active environment](../../CONTEXT.md): the backend rewrites that environment's `app/app.meta.json` atomically, then mirrors the values into its row and publishes an SSE event; an environment with no detected App is refused.
- The rule is latest writer wins: the agent may rewrite the file later, and is instructed to carry an existing name forward verbatim unless asked to rename.
- The App reads its own identity at runtime: the template frontend queries `/api/app-meta` at startup and sets the tab title, and the favicon is a neutral placeholder the agent overwrites at Go-live ([ADR-0010](../adr/0010-app-identity-read-at-runtime.md)).
- Gated by `can_edit_app_details` ([Permissions](../organization/permissions.md)).

## Edge cases

- When a published environment's Details are curated, the next Publish recopies Development's `app.meta.json` over them.
- When a Project predates the runtime-identity template, its App keeps a hardcoded title until regenerated.

## Code

- `backend/src/project/app.service.ts` — the per-environment App row upsert.
- `backend/src/project/project.service.ts` — the human edit path that rewrites the metadata file and mirrors it into the row.
- `project_app` in `backend/db/schema.ts` — App Details per ProjectEnvironment.
- `frontend/src/components/project/` — the app pane and the edit-details UI.

## Related

- [App Readiness](app-readiness.md) — the push that drives Go-live detection.
- [Environments](environments.md) — the App's public URL and App Auth.
- [File preview](file-preview.md) — the panel the App preview shares with files.
