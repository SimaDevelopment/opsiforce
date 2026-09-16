# Pod is disposable, the environment workspace is the durable unit

A ProjectEnvironment's pod is replaced for idle timeout, eviction, crash or reassignment, so nothing that must survive may live in the pod. The environment's workspace directory on the shared CephFS claim is the durable unit: the pod mounts it by `subPath`, and OpenCode's and code-server's state is made durable by redirecting all four XDG directories under `/workspace/.xdg`, so session databases, config and extensions land on the volume rather than in the container filesystem. A replacement pod with the same deterministic name mounts the same directory and resumes where the previous one stopped.

## Consequences

- Resume is a property of the workspace, not the pod: the remembered Session is validated against the live root sessions of the Active environment on every open.
- Deleting a Project or environment tombstones its directory before the live rows go, and a scheduled cleanup removes it after a retention window; a directory is never untracked.
- In-memory state (PTY sessions, live streams, temp files outside `/workspace`) is lost on every replacement by design.
