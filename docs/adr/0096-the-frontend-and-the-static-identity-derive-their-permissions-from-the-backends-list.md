# The frontend and the static identity derive their permissions from the backend's list

Inside Opsiforce, three places need every permission name: the backend's guards, the frontend's gates and the static identity in the `opsiforce-proxy` chart. Hand-written copies in each place drift apart, because nothing compares them. A missing entry either hides a feature from the people meant to have it, or leaves a raw string that no compiler checks.

**`PERMISSIONS` in `backend/src/permission/permission.constants.ts` is the list of every permission Opsiforce knows. The frontend and the static identity derive from it, and Keycloak keeps its own roles and bundles in the configurator.** Concretely:

- **Every call site writes the `can_*` string itself.** The backend writes `@RequirePermission('can_manage_workspaces')` and the frontend writes `hasPermission('can_manage_workspaces')`, so the same token names a permission in code, in Keycloak, in the docs and in 403 messages.
- **The gates take the type, not a string.** `Permission` is the union of the names in `PERMISSIONS`. These accept only a `Permission`, so an unknown or misspelled name fails `tsc`:
  - backend: `@RequirePermission`, `@RequireAnyPermission`, `requirePermissionHook`, `hasPermission` and `assertPermission`;
  - frontend: `hasPermission` and every `isPermitted`, through the `HasPermission` type.
- **The frontend imports only the type.** `frontend/src/constants/permissions.ts` takes `Permission` from the backend's file with `import type`. The build erases the import, so the frontend bundle carries no permission table and the frontend image needs nothing from the backend.
- **The static identity holds every permission except `can_manage_users`.**
  - Tilt computes the list from the file when it loads, passes it to the chart, and reloads when the file changes. The chart's own default is an empty list.
  - Static mode has no identity provider. `can_manage_users` only opens a Users page that embeds User Management, which static mode does not deploy.
- **The Azure deployment's admin group holds the whole list.** Its deploy workflow builds `SSO_GROUP_MAP` from `PERMISSIONS`, so a new permission reaches that deployment's admins with no edit there.
- **Keycloak stays separate.** The configurator under `packages/infra/pulumi/keycloak-configurator/` keeps its own role list and bundles, written by hand from `PERMISSIONS`, and deploys through its own workflow.
- **The file stays self-contained.** It has no imports and uses only erasable TypeScript, because Node strips its types for Tilt and for the Azure deploy workflow, and the frontend's `tsc` checks against it.

## Considered options

- **Keep the copies and add a test that compares them.** Rejected: CI builds the images but runs no tests, so the test would catch drift only on machines that run it. Deriving the lists removes the copies.
- **A JSON manifest that every consumer reads.** Rejected: JSON imports widen to `string`, which loses the `Permission` type that makes the gates reject an unknown name.
- **Generate a copy into each consumer.** Rejected: a generated file is still a copy, with a generation step that can be forgotten.
- **A camelCase constant at every call site**, such as `Perms.manageWorkspaces`. Rejected: it gives each permission a second name that appears nowhere outside the code, and in the frontend the bundler would need the backend's file, so the frontend image would have to copy it from another workspace.
- **The Keycloak configurator imports the list** and builds its roles and bundles from a scope on each entry. Rejected: the infrastructure would depend on the app's source tree, and its deploy workflow would have to run on app changes.
- **The backend expands a static-mode marker into every permission.** Rejected: the backend would have to know the deployment's auth mode, while static mode works by sending the same headers a real identity provider produces.

## Consequences

- Adding a permission is one entry in `PERMISSIONS` for Opsiforce, plus a role and a bundle entry in the Keycloak configurator. Only the Keycloak side can still drift: a permission missing there hides its feature from everyone in that deployment.
- A Keycloak role has to reach production no later than the Opsiforce release that gates on it.
- Moving or renaming `permission.constants.ts`, or the `PERMISSIONS` export, breaks the frontend's typecheck, Tilt and the Azure deploy workflow, each with an error.
- Renaming a permission's `can_*` string makes `tsc` flag every guard and gate that names it, to be fixed by hand.
- A standalone install that writes its own `SSO_GROUP_MAP` lists permission names outside the list, so renaming a permission means renaming it there too.
