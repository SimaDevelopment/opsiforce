---
kind: explanation
---

# Created Projects and Agents

> Which Agents may a pod create Projects of through the Public API, in which Workspace, and how many Projects and Agents may it create?

## How it works

- *Allowed Agents* (`createdProjectAgents`, a searchable multiselect of at most 50, empty in a new configuration) narrows `POST /projects`: empty allows any Agent the creator can start, otherwise only the listed ones. Its `createdProjectAgentChoices` options call offers the Agents the calling Project's creator (or, on an Agent's Service settings, the person configuring it) can start, by name. A Builder chat's Test Project is not narrowed by it.
- *Workspace for new Projects* (`createdProjectsWorkspace`, a searchable select, empty in a new configuration) puts every ordinary Project the pod creates in that shared Workspace: a `POST /projects` without `workspaceId` lands there, one naming another Workspace answers `403 permission-denied` with `Opsiforce-Setting: createdProjectsWorkspace`. Its `createdProjectWorkspaceChoices` options call offers the shared Workspaces the creator (or the person configuring an Agent) is a member of. A creator who is not a member answers `422 invalid-reference`, as any unknown Workspace does.
- *Project limit* counts every Project whose `created_by_project_id` is the calling Project and that still exists, of any kind (Test Projects included) and disabled or not; only a delete frees a slot. The count runs inside the create's transaction with the calling Project's row locked, so parallel creates never pass the cap. At the cap `POST /projects` answers `409 max-created-projects`: "This Project may create at most 5 Projects (Opsiforce Public API → Project limit). Delete one you created, or ask someone who can configure this Project's External Services to raise it." The depth-two chain stop (`409 chain-too-deep`) is checked first and the Organization Projects limit after, both unchanged. A configuration without the field counts against 5.
- *Agent limit* counts every Agent whose `created_by_project_id` is the calling Project and that still exists, inside the create's transaction with the calling Project's row locked, as *Project limit* does. At the cap `POST /agents` answers `409 max-created-agents`: "This Project may create at most 5 Agents (Opsiforce Public API → Agent limit). Ask someone who can configure this Project's External Services to raise it."

## Edge cases

- `POST /projects` with an Agent outside a non-empty *Allowed Agents* answers `403 permission-denied` with `Opsiforce-Outcome: not allowed` and `Opsiforce-Setting: createdProjectAgents`, its `detail` naming the setting. An Agent listed there that the creator can no longer start answers `422 invalid-reference`, as any unknown Agent does.
- A `POST /projects` naming a Workspace other than *Workspace for new Projects* answers `403 permission-denied` with `Opsiforce-Setting: createdProjectsWorkspace`; so does one without `workspaceId` while the creator is not a member of the chosen Workspace.
- A Builder chat's Test Project is checked against neither *Allowed Agents* nor *Workspace for new Projects*: it belongs to no Workspace and runs the chat's own subject.

## Code

- `backend/src/public-api/projects/projects.service.ts` — *Allowed Agents* and *Workspace for new Projects* on `POST /projects`.
- `backend/src/project/project-limit.ts` — the *Project limit* cap.
- `backend/src/agent/created-agents-cap.ts` — the *Agent limit* cap.
- `backend/src/external-services/built-ins/public-api-project-options.ts` — the *Allowed Agents* and *Workspace for new Projects* pickers.

## Related

- [Public API built-in](public-api.md) — the service and its other settings.
- [API Token](../public-api/api-token.md) — who an Agent Caller acts as.
