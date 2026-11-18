---
kind: explanation
adrs: [0009, 0098]
---

# Pod Tools

> Which processes run inside an environment pod, and how do the embedded VS Code and DB viewer reach the browser?

## How it works

### Processes

- Every environment pod runs six `guard`-supervised processes on the shared `/workspace` volume: the App server (`$APP_PORT`, 3000 from the Agent's registry entry), OpenCode (internal port, fronted on 4096), code-server (8080), Datasette (8081), agent-control, and the desktop manager ([Desktops](../projects/desktops.md)).
- A privileged pod also runs the Docker daemon as `docker`, on an ext4 disk image it builds at start on the pod-local `docker-storage` volume and mounts at `/var/lib/docker`, so Docker's images and containers last only as long as the pod ([ADR-0098](../adr/0098-docker-runs-as-a-guarded-process-in-privileged-kata-pods-on-a-disk-image-the-pod-throws-away-and-its-skill-exists-only-where-it-can-run.md)). When that storage cannot be prepared, the reason is in the `docker` [Process Log](../../GLOSSARY.md) and the other processes start as usual, and a `dockerd` that gives up leaves them running.
- Before the daemon starts, entrypoint moves the container's processes into a child cgroup, `init`, and hands every controller to its children, so a container's own memory and CPU limits apply within the pod's and a container that runs out of memory reports `OOMKilled`; processes started later, `kubectl exec` included, land in `init` too ([ADR-0098](../adr/0098-docker-runs-as-a-guarded-process-in-privileged-kata-pods-on-a-disk-image-the-pod-throws-away-and-its-skill-exists-only-where-it-can-run.md)). Where the cgroup cannot be changed, the daemon still starts, without those limits.
- `guard` writes its command's output and lifecycle events to that process's [Process Log](../../GLOSSARY.md) under `/workspace/data/logs/` ([Process Log](process-log.md)) and restarts the command whenever it exits, a clean exit included, with exponential backoff (2 s doubling to 60 s), until the guard itself is signalled or it gives up after 50 restarts in a row that each ran under 30 s, a run of 30 s or more resetting both the delay and the count. Every guarded process is meant to run for good, so a service stopped gracefully (by the App restart, say) comes back like a crashed one.
- The App's guard waits for an executable `/workspace/app/startup.sh` instead of running it straight away, so a workspace with no App yet idles quietly rather than crash-looping to `gave_up` ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- agent-control is the in-pod control process: it restarts the App's processes on request from the backend over the control port so the guards revive them with new values ([ADR-0009](../adr/0009-in-pod-control-process.md)), pushes [Go-live](../../GLOSSARY.md) to the backend, and fronts OpenCode with injected auth ([OpenCode Embed](../frontend/opencode-embed.md)). Run as `app-url` or `app-restart` (`agent-control app-url`, `agent-control app-restart`), it is instead a one-shot command for the agent: `app-url` prints the App's current Public URL to share ([App Readiness](../projects/app-readiness.md)), and `app-restart` stops `startup.sh` and everything it started, then waits until the App's guard runs `startup.sh` again from the top, so an edit to `startup.sh` takes effect; given the name of a guard that `startup.sh` started, it stops only what runs under that guard and waits until the guard has started its command again, and it refuses the name of one of the platform's own processes.
- Agents learn the pod's commands (`guard`, `process-logs`, `app-url`, `app-restart`, `agent-control`, `log-writer`, `agent-workspace-migrate`) by running them with `--help`, so each one's `-h`/`--help` prints to stdout and exits 0 without doing anything, giving when to use it, usage, copy-ready examples, options, whether it blocks, where its output goes and its exit codes, and the platform's own plumbing says so in its first line and points to what the Agent should use instead. Any other call it does not recognise, an unknown flag, a missing argument or none at all, prints that help to stderr and exits 2 without starting, writing or asking anything.
- Chat, Code and DB are lazy-loaded iframe tabs in the project view; once mounted a tab stays in the DOM, so switching never reloads it.

### Routing

- code-server and Datasette serve assets at absolute paths that break under a path prefix, so each has its own subdomain, `{envId}.code…` and `{envId}.db…`, handled by a dedicated runtime-proxy mode that runs the same ensure gate ([Request Flows](request-flows.md)).
- Both proxy modes strip `X-Frame-Options`, `Content-Security-Policy` and `Content-Encoding` from responses so the iframe can render them.

### VS Code

- code-server runs with `--auth none`: the platform edge authenticates every request before it reaches the proxy and the pod has no public port; the proxy strips `Origin` from WebSocket upgrades so code-server's own origin check accepts it.
- IDE settings and extensions persist under `/workspace/.xdg/code-server/`, the same XDG redirection OpenCode uses ([Persistence](persistence.md)).
- Gated by `can_view_code_tab` ([Permissions](../organization/permissions.md)).

### DB viewer

- Datasette serves three SQLite databases: the App's own database (writable through the write plugin), the request log (`data/database.db`, [Request Logging](../gateways/request-logging.md)), and the external-services database written only by the platform backend ([Event](../external-services/events.md)); the latter two are read-only.
- Per-database write permission is declared in `agent-config/datasette-metadata.yml`; the entrypoint seeds the external-services file before launch because Datasette refuses to open an absent file.
- Gated by `can_view_db_tab`.

## Edge cases

- When a user without `can_view_code_tab` or `can_view_db_tab` opens the subdomain directly with a valid platform session, the runtime-proxy path does not refuse; the permission gates only the tab.

## Code

- `agent-config/scripts/entrypoint.sh` — the guard-wrapped processes, the Docker storage and cgroup nesting of a privileged pod, and the database seeding.
- `proxy/cmd/agent-control/` — the control port, the readiness push, the OpenCode front proxy, the `app-url` and `app-restart` commands.
- `proxy/cmd/opsiforce-proxy/` — the single runtime-proxy binary and its vscode and db modes.
- `agent-config/datasette-metadata.yml` — per-database access.
- `frontend/src/components/project/` — the Chat, Code and DB tabs.

## Related

- [Request Flows](request-flows.md) — the topology and the ensure gate every surface runs.
- [Persistence](persistence.md) — the `/workspace/.xdg/` layout that makes IDE state durable.
- [Permissions](../organization/permissions.md) — the two tab permissions.
- [Process Log](process-log.md) — where each guarded process's output goes and how long it stays.
