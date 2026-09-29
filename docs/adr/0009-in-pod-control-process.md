# App restarts are triggered through an in-pod control process, not exec or file-watching

Applying Environment Variables only matters once the App re-reads `opsiforce.env.json`, which the starter reads at process boot. Recreating the pod is far too blunt for "I changed an API key": it tears down the agent session, code-server and Datasette along with the App, and takes the full schedule-and-boot path instead of the couple of seconds an App process restart costs. From outside a pod there are only two ways in: an HTTP port or the Kubernetes exec API.

**The agent container runs a small HTTP control process, `agent-control`, under its own `guard`, and the backend restarts the App by calling it. `POST /restart-app` restarts every process supervised by a `guard` nested under the `webapp` guard, whatever that guard is named.**

- **The process.** `entrypoint.sh` runs five guarded processes: `webapp` (the App's `startup.sh`), `opencode`, `vscode`, `dbviewer` and `control`. `agent-control` listens on its own port (`CONTROL_PORT`, default 4910) on the pod IP. The backend reaches it by direct pod-IP HTTP inside the cluster, with no ingress route. Every call carries a per-pod random token in `x-control-token`; the backend generates it at pod creation and injects it as `OPSIFORCE_CONTROL_TOKEN`.
- **The restart.** `agent-control` walks the process tree under the `webapp` guard, finds every nested `guard`, and sends SIGTERM to the processes each one supervises, then SIGKILL to any still alive after two seconds. It skips the log writers and leaves `startup.sh` and the guards running, so each guard revives its process, which reads the new values. It answers `{"killed": N}`.
- **The fallback.** Apply-with-restart writes the env file atomically on the shared mount, then makes one call. When the call cannot restart the App — no token on the pod, the port unreachable, an error reply, or `killed: 0` because nothing runs under a nested guard — the backend recreates the pod instead and reports `restart: "pod"`. A restart that restarted nothing is never reported as an App restart.
- **Process names don't matter.** The restart depends only on the `webapp` guard in `entrypoint.sh` and on `guard` itself, never on the names `startup.sh` gives its processes. The `platform` skill's rule that every long-running process runs under `guard` is what makes any stack's App restartable in place ([ADR-0061](0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)).
- **One generic channel.** Later needs ride the same port instead of inventing new signalling. `POST /notify-config-change` ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)) is the second route, and the readiness push ([ADR-0015](0015-app-liveness-pushed-not-polled.md)) runs in the same process.

## Considered options

- **Kubernetes `pods/exec`** — the backend runs `pkill` in the pod through the API server, with no image change. Rejected: exec rights over every agent pod make the backend omnipotent inside all of them.
- **inotify on `opsiforce.env.json`** — fully automatic. Rejected: inotify events do not cross CephFS client mounts, so backend writes are invisible. It works on a single-node hostPath setup and breaks in production.
- **A sentinel file and a polling loop** — works everywhere with trivial code, but it is polling with up to a second of latency and a marker protocol to maintain, when an evented channel costs barely more.
- **Pod recreation alone** — no new code, but a disproportionate disruption for a config edit, and on Development it recycles the pod the user is working in.

## Consequences

- The control token is part of the pod contract: known to the backend and never exposed through ingress. Rotating it means recreating the pod.
- The control port is one more port on the agent pod, guarded only by the token. A network policy for agent pods must scope it to the backend.
- An App whose server runs outside `guard` answers `killed: 0`, so applying variables recreates its pod.
