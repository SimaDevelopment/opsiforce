---
kind: explanation
terms: [Resources]
adrs: [0005]
---

# Resources

> How is a [Project](../../CONTEXT.md)'s pod size chosen, stored and applied to its environments?

## How it works

- [Resources](../../CONTEXT.md) is a Project-level policy: one class, Small, Medium, Large or Custom, applies to every pod the Project runs, [Development](../../CONTEXT.md) and published environments alike ([ADR-0005](../adr/0005-pod-class-project-level-snapshot.md)).
- Picking a preset snapshots that preset's CPU and memory numbers into the Project's row; Custom stores the typed numbers clamped to safe bounds. The pod builder reads only those numbers and never re-derives them from a preset name.
- The preset catalog and the Custom bounds live in the backend and are served to the UI, so the frontend hardcodes no sizing numbers.
- Changing Resources writes the row and nothing else; the new size materialises when the pod is next created, on an idle resume or through the Restart to apply action shown after a change, which targets the [Active environment](../../CONTEXT.md).
- New Projects, including those claimed from the [pending project pool](pending-project-pools.md), start at Small; duplicating a Project copies its Resources.
- The Small preset's numbers can differ per deployment through a Helm value, so agent pods fit a single-node minikube locally; every stored row stays authoritative for its own pod.
- Gated by `can_manage_project_pod_settings` on the Resources tab and its endpoint ([Permissions](../organization/permissions.md)).

## Edge cases

- When Resources changes while other environments are running, each adopts the new size on its own next restart or resume.

## Code

- `backend/src/pod/pod-classes.ts` — the preset catalog, Custom bounds and clamping.
- `project_pod_settings` in `backend/db/schema.ts` — the snapshotted numbers per Project.
- `backend/src/project/` — the pod-class read and update endpoints.
- `frontend/src/components/project/resources-selector.tsx` — the Resources tab.

## Related

- [Pod Lifecycle](pod-lifecycle.md) — why applying a size is always a pod recreate.
- [Pods](pods.md) — the class shown per running pod.
