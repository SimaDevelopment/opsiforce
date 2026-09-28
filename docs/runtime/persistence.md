---
kind: explanation
adrs: [0042]
---

# Persistence

> What survives a pod being replaced, where does it live, and how does an environment resume and eventually get cleaned up?

## How it works

### The workspace is the durable unit

- A [ProjectEnvironment](../../CONTEXT.md)'s pod is disposable; its workspace directory on the shared claim is what persists, mounted into the pod by `subPath` ([ADR-0042](../adr/0042-pod-is-disposable-the-environment-workspace-is-the-durable-unit.md)).
- [Development](../../CONTEXT.md)'s directory is `projects/{projectId}`; published environments get their own directories.
- On the volume: the OpenCode session database and chat history, the App source and git history, the App's SQLite databases and generated output, agent config and skills copied into the workspace, code-server settings and extensions, and uploaded files.
- In the pod only: in-memory process state, PTY sessions, live connections and in-flight streams, and temp files outside `/workspace`.
- The pod template redirects all four XDG directories under `/workspace/.xdg/`, so OpenCode and code-server state lands on the volume.

### Replacement and resume

- A replacement pod carries the same deterministic name, mounts the same directory, and starts OpenCode against the persisted XDG state; the backend caches the new IP and flips the environment to `active`, and the frontend reconnects ([Pod Lifecycle](pod-lifecycle.md)).
- The primary [Session](../../CONTEXT.md) binding is resolved during a [Connection](../public-api/connection.md) against the environment's live root sessions, so a replacement pod resumes the same conversation and a stale id never leaks into a freshly published environment.

### Cleanup

- Deleting a [Project](../../CONTEXT.md) or environment writes a tombstone row per environment before the live rows go, so a directory is never untracked.
- A daily job removes workspaces whose tombstone is older than seven days and sweeps the `projects/` root for directories with neither a live row nor a tombstone; the same run sweeps `agent-templates/` ([Template](../agent-system/template.md)).
- Operators holding `can_manage_platform_storage` can run the same job for one [Organization](../../CONTEXT.md) with the retention window ignored from the [Storage](storage.md) page.

## Edge cases

- When a directory removal fails, the tombstone stays and the next daily run retries it.
- When a duplication or publish crashes, its hidden temp directory under `projects/` is exempt from the orphan sweep until it is seven days old, then reaped.
- When an environment is deleted by mistake, its files are recoverable for seven days.

## Code

- `backend/src/pod/pod.template.ts` — the `subPath` mount and the XDG redirection.
- `backend/src/cleanup/` — the workspace cleanup job, retention window and orphan sweep.
- `deleted_project_environments` in `backend/db/schema.ts` — the tombstones.

## Related

- [Storage](storage.md) — how the bytes on this volume are counted and attributed.
- [Pod Lifecycle](pod-lifecycle.md) — pod replacement, suspension and the deterministic name.
- [Connection](../public-api/connection.md) — how the primary Session is bound on every connection.
- [Environments](../projects/environments.md) — why each environment has its own directory.
