---
kind: operations
---

# Deployment

> Ship Opsiforce to a cluster through the CI workflow, in the order the charts depend on each other.

## Prerequisites

- The GitHub Actions workflow at the monorepo root, `.github/workflows/opsiforce.yml`, with GHCR and target-cluster credentials configured.
- The Helm charts under `helm/`.

## Steps

1. Push. A push to `main` deploys to the development namespace, a push to `production-opsiforce` deploys to production, and a pull request builds only.
2. Images build in parallel: backend, frontend, agent and runtime-proxies, all in one GHCR repository distinguished by tag prefix. Each gets `{component}-{env}-{sha7}` and a stable `{component}-{env}` pointer; pull requests tag `{component}-pr-{n}-{sha7}` and are not pushed. The agent image tag is injected into the backend chart as `AGENT_CONTAINER_IMAGE`, so a deploy pins every new pod to that build ([Pod Lifecycle](../runtime/pod-lifecycle.md)).
3. Charts deploy sequentially, each depending on the one before:

   ```
   1. opsiforce (infra)   creates the ServiceAccount and the CephFS PVC everything else mounts
   2. bifrost             the backend calls its Admin API on boot
   3. gotenberg           no boot dependency; ordered here so the converter Service exists first
   4. opsiforce-backend   the proxies call its control API
   5. opsiforce-frontend  ─┐ both must exist before the edge proxy routes to them
   6. runtime-proxies     ─┘ four Go deployments from one image
   7. opsiforce-proxy     nginx, oauth2-proxy and the Traefik IngressRoutes fanning out to all of the above
   ```

   Gotenberg carries a pinned upstream image and a fixed Service name, so its step takes no `--set`; the other charts are wired with `--set` flags carrying service names, the agent image tag, the PVC name and the Bifrost URL. Release names follow `opsiforce-{chart}-{env}`.
4. Rollout. Every deployment carries a `rollme` annotation with a random value, so `helm upgrade` rolls pods even when the image tag is unchanged, and `--wait` blocks each chart until its pods are Ready; every container has a `preStop: sleep 30` hook so the old pod keeps serving in-flight requests for 30 seconds after SIGTERM.
5. Bifrost. The upstream chart is deployed from its public Helm repository with the image pinned in `helm/bifrost/values.{prod,local}.yaml` ([LLM Gateway](../gateways/llm-gateway.md)).

## Verify

- Each chart's `--wait` returns with its pods Ready, in order.
- A new agent pod runs the image tag the backend chart injected.
- The running Bifrost pod's image matches the pinned tag in the values file.
