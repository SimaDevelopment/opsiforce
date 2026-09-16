# Local development runs on Tilt with a static identity and no identity provider

Everything that runs continuously in local development is a Tilt resource, in-cluster workloads and host-side processes alike, so the stack lives under one view with per-process logs and a restart button per service, real dependency ordering, and reconciliation on every run rather than a one-time infra step that a day-two run would skip. There is no identity provider locally: the ingress runs in static auth mode, drops the oauth2-proxy sidecar and injects a fixed `test` user in the `local` tenant with every permission the backend defines, and the backend treats those headers as authoritative and auto-provisions the tenant, user and protected Environments on the first request.

## Considered options

- **A one-time setup script plus ad hoc process runners.** Rejected: a multi-process firehose, no single restart point, and third-party pieces (the document converter) skipped on day two.
- **A local Keycloak.** Rejected: a second heavy service to seed and keep in step for a single static user.

## Consequences

- `minikube tunnel` is the one privileged step; it is primed with a single `sudo` prompt, launched detached, survives the orchestrator exiting and is detected on re-run.
- The static permission list in the chart is kept identical to the backend's permission enum, so there are no permission walls locally.
- A NetworkPolicy can never be proven locally: minikube's default CNI enforces none.
