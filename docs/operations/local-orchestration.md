---
kind: operations
---

# Local orchestration

> Operate the long-lived processes the Quickstart leaves running: the network tunnel, Tilt, and the static identity that signs you in.

Everything that runs continuously locally is a Tilt resource, in-cluster workloads and host-side processes alike, and the ingress runs in static auth mode with a fixed identity and no identity provider ([ADR-0050](../adr/0050-local-development-runs-on-tilt-with-a-static-identity-and-no-identity-provider.md), [Request Flows](../runtime/request-flows.md)).

## Prerequisites

- `yarn dev` has run at least once ([Quickstart](quickstart.md)).

## Steps

1. The tunnel. `minikube tunnel` routes localhost `:443` to the cluster's Traefik load balancer so `https://opsiforce.localtest.me` resolves. The Quickstart primes `sudo` once, launches the tunnel detached with its log at `~/.opsiforce/logs/tunnel.log`, detects an already-running tunnel on re-run, and stops it on `yarn dev --reset`.
2. Tilt. Open `https://tilt.opsiforce.localtest.me` (or `http://localhost:10350`) for per-process logs, status and a restart button per service; Tilt orders resources by dependency (the proxy waits on the backend and the runtime proxies). In-cluster resources are the backend, the four runtime proxies, the `opsiforce-proxy` ingress in static mode and the document converter, whose images Tilt builds into minikube's daemon and deploys with the Helm charts. Host-side resources are the Vite dev server, the codex proxy on the subscription path (reading the recorded choice from `~/.opsiforce/config.json`), data-store port-forwards, and an optional mail stub that is off by default; the cluster reaches them over `host.minikube.internal`.
3. The static identity. In static mode the `opsiforce-proxy` nginx drops the oauth2-proxy sidecar and injects a fixed identity on backend-bound requests: a `test` user, the `local` tenant, and every permission the backend defines, kept identical to the permission enum by the chart. The backend treats those headers as authoritative and auto-provisions the tenant, the user and its Development and Production Environments on the first request; `OIDC_PLUGIN_SECRET` must be non-empty in the local values for the backend to boot and to apply App Auth middleware.

## Verify

- `https://opsiforce.localtest.me` opens in the `local` organization with full admin access and no login screen.
- The Tilt UI shows the core services healthy, and a day-two `yarn dev` fast-paths to a healthy stack.
