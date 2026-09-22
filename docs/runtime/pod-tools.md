---
kind: explanation
adrs: [0009]
---

# Pod Tools

> Which processes run inside an environment pod, and how do the embedded VS Code and DB viewer reach the browser?

## How it works

### Processes

- Every environment pod runs five `guard`-supervised processes on the shared `/workspace` volume: the App server (`$APP_PORT`, 3000 from the Agent's registry entry), OpenCode (internal port, fronted on 4096), code-server (8080), Datasette (8081), and agent-control.
- The App's guard waits for an executable `/workspace/app/startup.sh` instead of running it straight away, so a workspace with no App yet idles quietly rather than crash-looping to `gave_up` ([ADR-0061](../adr/0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- agent-control is the in-pod control process: it restarts the App's processes on request from the backend over the control port so the guards revive them with new values ([ADR-0009](../adr/0009-in-pod-control-process.md)), pushes [Go-live](../../CONTEXT.md) and [Agent Status](../../CONTEXT.md) to the backend, and fronts OpenCode with injected auth ([OpenCode Embed](../frontend/opencode-embed.md)).
- Chat, Code and DB are lazy-loaded iframe tabs in the project view; once mounted a tab stays in the DOM, so switching never reloads it.

### Routing

- code-server and Datasette serve assets at absolute paths that break under a path prefix, so each has its own subdomain, `{envId}.code…` and `{envId}.db…`, handled by a dedicated runtime-proxy mode that runs the same ensure gate ([Request Flows](request-flows.md)).
- Both proxy modes strip `X-Frame-Options`, `Content-Security-Policy` and `Content-Encoding` from responses so the iframe can render them.

### VS Code

- code-server runs with `--auth none`: the platform edge authenticates every request before it reaches the proxy and the pod has no public port; the proxy strips `Origin` from WebSocket upgrades so code-server's own origin check accepts it.
- IDE settings and extensions persist under `/workspace/.xdg/code-server/`, the same XDG redirection OpenCode uses ([Persistence](persistence.md)).
- Gated by `can_view_code_tab` ([Permissions](../organization/permissions.md)).

### DB viewer

- Datasette serves three SQLite databases: the App's own database (writable through the write plugin), the platform observability database, and the external-services database written only by the platform backend ([Service template](../external-services/service-template.md)); the latter two are read-only.
- Per-database write permission is declared in `agent-config/datasette-metadata.yml`; the entrypoint seeds the external-services file before launch because Datasette refuses to open an absent file.
- Gated by `can_view_db_tab`.

## Edge cases

- When a user without `can_view_code_tab` or `can_view_db_tab` opens the subdomain directly with a valid platform session, the runtime-proxy path does not refuse; the permission gates only the tab.

## Code

- `agent-config/scripts/entrypoint.sh` — the five guard-wrapped processes and the database seeding.
- `proxy/cmd/agent-control/` — the control port, status and readiness pushes, the OpenCode front proxy.
- `proxy/cmd/opsiforce-proxy/` — the single runtime-proxy binary and its vscode and db modes.
- `agent-config/datasette-metadata.yml` — per-database access.
- `frontend/src/components/project/` — the Chat, Code and DB tabs.

## Related

- [Request Flows](request-flows.md) — the topology and the ensure gate every surface runs.
- [Persistence](persistence.md) — the `/workspace/.xdg/` layout that makes IDE state durable.
- [Permissions](../organization/permissions.md) — the two tab permissions.
