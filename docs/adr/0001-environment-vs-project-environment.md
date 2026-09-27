# Two entities for environments: tenant `Environment` registry vs per-project `ProjectEnvironment`

**"Environment" is two entities.** An **`Environment`** is a tenant-scoped registry row (`name`, `description`, `isDefault`): the publish targets offered to every Project in the Organization, with a protected **Development** seeded per tenant and others (Production, Staging…) added by admins. A **`ProjectEnvironment`** is a per-project instance that references an `Environment` and owns all runtime state: its directory, pod, status and pod IP, `platformVersion`, `lastActiveAt`, its gateway keys, its `authMode` and its schedules. The **`Project`** is a shell: identity (tenant, workspace, agent, title, description), cross-environment policy (`disabled`), and the project-level budget and timeouts.

Two entities let publish targets be governed tenant-wide and propagate by reference (renaming "Production" to "Prod" once updates every Project), while each Project's running instances stay independent.

## Considered options

- **A single `ProjectEnvironment` with free-text names.** Rejected: nothing governs the set of targets, and a rename has to touch every Project.
- **A tenant config list of allowed names.** Rejected: names are not rows, so nothing can reference them and a rename still does not propagate.

## Consequences

- `project_settings` holds timeouts and timezone on the Project; `authMode` lives on the `ProjectEnvironment`.
- The Bifrost team and its virtual-key pair stay on the Project and are shared by all its environments ([ADR-0003](0003-one-bifrost-team-per-project-keys-per-env.md)).
- App Details are per environment: each `ProjectEnvironment` is its own App ([ADR-0016](0016-app-details-are-per-environment.md)).
- Agent-config updates reach every environment: the content update runs on each `ProjectEnvironment`, and only the template migrations run on Development alone.
