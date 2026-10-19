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
2. Images build in parallel: backend, frontend, agent, runtime-proxies and linked-account-proxy, all in one GHCR repository distinguished by tag prefix. Each gets `{component}-{env}-{sha7}` and a stable `{component}-{env}` pointer; pull requests tag `{component}-pr-{n}-{sha7}` and are not pushed. The agent image tag is injected into the backend chart as `AGENT_CONTAINER_IMAGE`, so a deploy pins every new pod to that build ([Pod Lifecycle](../runtime/pod-lifecycle.md)).
3. Charts deploy sequentially, each depending on the one before:

   ```
   1. opsiforce (infra)   creates the ServiceAccount and the CephFS PVC everything else mounts
   2. bifrost             the backend calls its Admin API on boot
   3. gotenberg           no boot dependency; ordered here so the converter Service exists first
   4. opsiforce-backend   the proxies call its control API
   5. linked-account-proxy  fetches Linked-account tokens from the backend; Bifrost calls it by Service name
   6. opsiforce-frontend  ─┐ both must exist before the edge proxy routes to them
   7. runtime-proxies     ─┘ five Go deployments from one image (agent, app, vscode, db, external-service)
   8. opsiforce-proxy     nginx, oauth2-proxy and the Traefik IngressRoutes fanning out to all of the above
   ```

   Gotenberg carries a pinned upstream image and a fixed Service name, so its step takes no `--set`; the linked-account proxy takes its `values.{development,production}.yaml` and its image tag, and a standalone install deployed with the Helm charts uses `values.standalone.yaml`. Its service token is the `opsiforce-linked-account-proxy-service-token` Secret, created once with a random value and handed to the backend as `LINKED_ACCOUNT_PROXY_SERVICE_TOKEN`; the other charts are wired with `--set` flags carrying service names, the agent image tag, the PVC name and the Bifrost URL. Release names follow `opsiforce-{chart}-{env}`.
4. Rollout. Every deployment carries a `rollme` annotation with a random value, so `helm upgrade` rolls pods even when the image tag is unchanged, and `--wait` blocks each chart until its pods are Ready; every container has a `preStop: sleep 30` hook so the old pod keeps serving in-flight requests for 30 seconds after SIGTERM.
5. Backend settings. The backend chart refuses to render without `config.externalServicesEncryptionKey`, from the `EXTERNAL_SERVICES_ENCRYPTION_KEY` GitHub secret; generate one with `openssl rand -hex 32` and back it up, since every sealed secret (Service configuration secrets, Linked-account sign-ins) is unreadable without it, and the backend itself refuses to boot on a missing or malformed key. Set `config.opsiforcePublicUrl` (`OPSIFORCE_PUBLIC_URL`) to the deployment's public origin: it is the base of every webhook URL a service registers with its vendor, the chart refuses to render without it and the backend refuses to boot unless it is an absolute `http(s)` URL ([ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)).
6. Bifrost. The upstream chart is deployed from its public Helm repository with the image pinned in `helm/bifrost/values.{prod,local}.yaml` ([LLM Gateway](../gateways/llm-gateway.md)). Its values declare the platform's `openai` and `anthropic`, whose keys the `opsiforce-bifrost-provider-keys` Secret supplies, synced from the `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` GitHub secrets, and `custom-openai-1`, whose Codex OAuth Dock `base_url` the workflow passes with `--set-string`. It runs with the `split` source of truth, so providers and keys changed on Settings → Model providers survive a restart while their Helm entry is unchanged. An environment that ran before Model providers follows [Cut over from Helm](cutover-from-helm.md).

## Verify

- Each chart's `--wait` returns with its pods Ready, in order.
- A new agent pod runs the image tag the backend chart injected.
- The running Bifrost pod's image matches the pinned tag in the values file.
