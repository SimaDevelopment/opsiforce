---
kind: explanation
terms: [Resources]
adrs: [0005]
---

# Resources

> How is a [Project](../../GLOSSARY.md)'s pod size chosen, stored and applied to its environments?

## How it works

- [Resources](../../GLOSSARY.md) is a Project-level policy: one class, Small, Medium, Large or Custom, applies to every pod the Project runs, [Development](../../GLOSSARY.md) and published environments alike ([ADR-0005](../adr/0005-pod-class-project-level-snapshot.md)).
- Picking a preset snapshots that preset's CPU and memory numbers into the Project's row; Custom stores the typed numbers clamped to safe bounds. The pod builder reads only those numbers and never re-derives them from a preset name.
- The preset catalog and the Custom bounds live in the backend and are served to the UI, so the frontend hardcodes no sizing numbers.
- Changing Resources writes the row and nothing else; the new size materialises when the pod is next created, on an idle resume or through the Restart to apply action shown after a change, which targets the [Active environment](../../GLOSSARY.md).
- A new Project, including one claimed from the [pending project pool](pending-project-pools.md), starts at its Agent's Resources: Small for a Built-in Agent, and whatever a Custom Agent's page sets, copied once so a later change to the Agent reaches no existing Project ([ADR-0093](../adr/0093-an-agent-sets-the-resources-and-ready-projects-of-the-projects-created-from-it.md)). Duplicating a Project copies its own Resources, and importing one keeps the bundle's, or the Agent's when the bundle carries none.
- The Small preset's numbers can differ per deployment through a Helm value, so agent pods fit a single-node minikube locally; every stored row stays authoritative for its own pod.
- Gated by `can_manage_project_pod_settings` on the Resources tab and its endpoint; a Custom Agent's Settings (`PUT /agents/:id/pod-class`) is part of managing the Agent, under `can_manage_agents`, and a Built-in Agent's default comes from `podClass` in `agents.json` ([Permissions](../organization/permissions.md)).

## Edge cases

- When Resources changes while other environments are running, each adopts the new size on its own next restart or resume.

## Code

- `backend/src/pod/pod-classes.ts` — the preset catalog, Custom bounds and clamping.
- `project_pod_settings` in `backend/db/schema.ts` — the snapshotted numbers per Project.
- `backend/src/project/` — the pod-class read and update endpoints.
- `agent_pod_settings` in `backend/db/schema.ts` — a Custom Agent's pod settings, copied into every new Project's row.
- `frontend/src/components/resources/` — the Resources selector and its draft, shared by the Project's and the Agent's Settings.

## Related

- [Pod Lifecycle](pod-lifecycle.md) — why applying a size is always a pod recreate.
- [Pods](pods.md) — the class shown per running pod.
