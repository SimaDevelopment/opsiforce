---
kind: operations
---

# Cut over from Helm

> Move an existing environment's traffic onto Settings → Model providers, and its `custom-openai-1` off the hosted Codex OAuth Dock, without a gap.

The Bifrost Helm values keep declaring the platform's `openai`, `anthropic` and, in production, `custom-openai-1`, and Bifrost runs with the `split` source of truth, so a provider or key written through the Admin API survives a restart while its Helm entry is unchanged ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-chat-keys.md)).

## Prerequisites

- An environment that already runs Opsiforce, with Organizations in its database. A fresh install skips this page: its backend adopts the Helm-declared `openai` and `anthropic` at first boot ([LLM Gateway](../gateways/llm-gateway.md)).
- `kubectl` pointed at the environment's cluster, with read access to its Secrets and permission to port-forward, plus `curl` and Node 24.
- The environment's Bifrost running the image pinned in `helm/bifrost/values.{prod,local}.yaml` (`v2.0.0`), with `opsiforce-bifrost-admin-auth` and `opsiforce-bifrost-provider-keys` in its namespace.
- For step 5, a user holding `can_manage_platform_model_providers` (the Keycloak group `opsiforce_manage_platform_model_providers`) and the ChatGPT account `custom-openai-1` serves today.

## Steps

Run every step in one environment before starting the next: the development namespace (`opsiforce-development`, a push to `main`), then production (`opsiforce-production`, a push to `production-opsiforce`), then any standalone install deployed with the Helm charts. The local stack follows the same steps in the `local` namespace, deploying from the main checkout. In CI, one push deploys steps 2 to 4 together, in the workflow's chart order ([Deployment](deployment.md)).

1. **Store the keys (optional).** CI never runs this step, and the Helm providers keep working without it, since their Secret still supplies the env. Run it by hand, per namespace, to make Bifrost's database hold the `openai` and `anthropic` keys as values of their own: from the package root, `sh scripts/store-bifrost-provider-keys.sh <namespace>`. It reads the admin credentials and the provider key values from the namespace's Secrets, port-forwards `svc/opsiforce-bifrost`, and rewrites every key whose value is an `env.*` reference as a `plain_text` value through `PUT /api/providers/{provider}/keys/{key_id}`. It stops before writing anything when a referenced variable is missing, keeps a reference whose Secret value is empty, and is safe to run again. Run it after step 2: a restart still on `config.json` turns the keys back into references.
   - Check: each output line reads `stored`, `already value` or `empty, kept`, a second run prints no `stored` line, and `GET /api/providers/openai/keys` and `GET /api/providers/anthropic/keys` show `"type": "plain_text"` on each key.
2. **Switch Bifrost to `split`.** Deploy the values with `bifrost.sourceOfTruth: "split"`: the push for the CI environments, `sh scripts/install-bifrost.sh` for the local stack.
   - Check: `kubectl get configmap opsiforce-bifrost-config -n <namespace> -o jsonpath='{.data.config\.json}'` contains `"source_of_truth":"split"` and still lists `openai`, `anthropic` and, in production, `custom-openai-1` under `providers`.
3. **Migrate the rows.** The backend deploy applies migration `0074_model-providers`. On a database with Organizations it creates the platform rows `openai`, `anthropic` and `custom-openai-1`, switched on at weights 0 / 1 / 1, which every Organization inherits; no Organization gets rows of its own. It leaves the `chat` keys as they are: they keep `openai` 0, `anthropic` 1, `custom-openai-1` 0.3, which routes the same, until an Organization's first provider change rewrites them from its rows. `custom-openai-1` still points at the hosted Codex OAuth Dock, so traffic is unchanged.
   - Check: `SELECT tenant_id, bifrost_provider, enabled, weight FROM model_providers ORDER BY tenant_id NULLS FIRST, bifrost_provider` lists only the three platform rows, each with an empty `tenant_id`, and a Project's `chat` key in the Bifrost dashboard still lists `openai`, `anthropic` and `custom-openai-1`.
4. **Deploy `linked-account-proxy`.** The same push builds the `linked-account-proxy-<env>-<sha7>` image and deploys the `opsiforce-linked-account-proxy` chart with `values.<env>.yaml`, one replica. The workflow creates the `opsiforce-linked-account-proxy-service-token` Secret once with a random value and hands the same value to the backend. Push to `production-opsiforce` only once development has passed step 5. A standalone install creates that Secret itself, with a `LINKED_ACCOUNT_PROXY_SERVICE_TOKEN` key, passes the same value to the backend chart as `config.linkedAccountProxyServiceToken`, and deploys the chart with `values.standalone.yaml`.
   - Check: `kubectl rollout status deployment/opsiforce-linked-account-proxy -n <namespace>` succeeds, `kubectl get svc opsiforce-linked-account-proxy -n <namespace>` exists, and the backend pod's `LINKED_ACCOUNT_PROXY_SERVICE_TOKEN` equals the Secret's value.
5. **Sign in `custom-openai-1`.** As the platform admin, open Settings → Model providers, click **Sign in** beside Not signed in on the `custom-openai-1` row of the OpenAI card, open `auth.openai.com/codex/device` and enter the code shown. On completion the backend writes a `lap_…` key and the proxy's URL into `custom-openai-1`, and that write is the switch: requests go to the Codex OAuth Dock up to it and to the proxy after it, with no window to schedule ([Linked-account Proxy](../gateways/linked-account-proxy.md)). The Helm entry keeps the Codex OAuth Dock URL, and `split` keeps the signed-in version while that entry is unchanged.
   - Check: the row reads Working and "Signed in as" the account's email, with Linked account as its kind; in the Bifrost dashboard `custom-openai-1` has `base_url` `http://opsiforce-linked-account-proxy:8455/v1` and one `lap_…` key; a chat with `openai/gpt-5.6-sol` answers and `kubectl logs deployment/opsiforce-linked-account-proxy -n <namespace>` shows no 401 or 502.
6. **Leave the Codex OAuth Dock running.** After step 5 nothing in the environment calls the hosted Codex OAuth Dock. It keeps running for CI review only.
   - Check: the Codex OAuth Dock's own request log shows no calls from the environment's Bifrost after the sign-in.

## Verify

- `kubectl rollout restart deployment/opsiforce-bifrost -n <namespace>` leaves every provider in `GET /api/providers`, `custom-openai-1` included, with its `lap_…` key and the proxy's `base_url`.
- A provider added by a platform admin, or by an Organization, is still listed after that restart.
- Chats through `openai`, `anthropic` and `custom-openai-1` answer.
- A change to a provider's entry in `helm/bifrost/values.*.yaml` makes the file win for that provider at the next restart; after such a deploy, re-enter its key, while a Connected `custom-openai-1` gets its `lap_…` key and the proxy's `base_url` back from the backend at its next boot, so restart the backend if it did not restart after Bifrost.
