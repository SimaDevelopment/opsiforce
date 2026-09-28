# App Details are per-environment; each ProjectEnvironment is its own App

The source of an App's details (name and description) is `app.meta.json`, and each `ProjectEnvironment` carries its own copy. **`projectApps` is keyed by `project_environment_id`: each environment is its own App with its own App Details, and writes only its own row.** The DB matches the file reality, so a published environment running an older snapshot can never overwrite Development's curated name. The Project is a shell that groups several Apps, and each App is reached directly at its environment's URL.

## Considered options

- **One App per Project, with identity writes gated to Development** (upsert only when the gateway key belongs to the environment whose id equals the project id, per [ADR-0002](0002-development-environment-reuses-project-id.md)). Rejected: it leaves the row out of step with the per-environment files, cannot show what a published URL actually serves, and puts source-gating logic in the hot path.

## Consequences

- **Schema.** The primary key is `project_environment_id`; `project_id` is kept, denormalized, for grouping. The row stores no icon: an App's icon is the favicon its own code serves.
- **Editing** targets one environment: `updateApp` takes an `environmentId` (Development when omitted), writes that environment's `app.meta.json` and its own row. A published App's edits are transient: its next publish brings Development's file ([ADR-0004](0004-git-based-incremental-publish.md)).
- **Deleting an environment** deletes its App row by FK cascade.
- **Pushes are cheap.** `upsertProjectApp` reads the stored row first and skips both the write and the SSE when the reported name and description are unchanged, so only a first go-live or a real rename writes and notifies ([ADR-0015](0015-app-liveness-pushed-not-polled.md)).
