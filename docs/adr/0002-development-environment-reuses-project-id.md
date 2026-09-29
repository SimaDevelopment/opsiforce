# The Development `ProjectEnvironment` reuses the `Project`'s id

Public routing keys off an opaque id in the subdomain (`{id}.apps.dev`, `…code.dev`, `…db.dev`), pod names derive from it (`opsiforce-agent-{id[:8]}`), and the workspace directory is `projects/{id}`. When introducing per-environment instances, the migration sets each project's Development `ProjectEnvironment.id = projectId`; only non-default (published) environments get fresh uuids.

This is deliberate: reusing the projectId keeps every existing URL, pod name, on-disk directory, and satellite FK **byte-for-byte valid**. It turns what would be a high-risk data migration (rename CephFS directories, recreate pods, break live app URLs, issue redirects) into a metadata-only one — insert env rows and set `environmentId = projectId` (the value the satellite rows already hold).

## Consequences

- A future reader will notice that Development env ids look like project ids while other env ids are random uuids. **This asymmetry is intentional — do not "normalize" it.** Giving Development a fresh uuid would require a coordinated URL/pod/directory migration plus a redirect map for live links.
- The routing key is uniformly "the env id"; Development's simply equals its project's id.
- The public app hostname appends an environment slug to the env id, which stays the routing key ([ADR-0012](0012-public-app-hostnames-carry-environment-slug.md)).
