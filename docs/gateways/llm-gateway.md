---
kind: explanation
adrs: [0003]
---

# LLM Gateway

> How does a [Project](../../GLOSSARY.md)'s pod reach an LLM without holding a provider key, and how are budgets enforced across its environments?

## How it works

### Keys and budgets

- Bifrost sits between agent pods and the upstream providers; real provider keys live only in Bifrost, as encrypted values in its database or, for a Helm-declared provider's `env.*` key reference, in the Secret its environment reads, the backend talks to Bifrost's Admin API with basic auth, and pods receive per-Project virtual keys.
- Each Project has one Bifrost team and two virtual keys distinguished by `key_type`: `chat` for the OpenCode Agent (injected as the OpenAI and Anthropic key and base URL pairs) and `backend` for the built App's own AI features (`APP_LLM_API_KEY`, `APP_LLM_BASE_URL`), which the `llm-api` skill teaches the Agent to use.
- Both keys are shared by every [ProjectEnvironment](../../GLOSSARY.md) of the Project; a [Publish](../projects/publish.md) never mints new keys, and the budget cap is anchored on the single team ([ADR-0003](../adr/0003-one-bifrost-team-per-project-keys-per-env.md)).
- Budgets nest Customer (tenant), Team (Project) and Virtual Key, and all three must have remaining budget for a request to proceed; tenants and Projects seed their caps from [Defaults](../organization/defaults.md) at creation and manage them through the Billing UI.
- A [pending project pool](../runtime/pending-project-pools.md) slot carries an orphan team with no customer; the claim patches the team's customer to the claiming tenant and the baked keys stay valid.

### Provider routing

- Each virtual key carries its own candidate providers, picked by weight, and a provider serves only models it offers.
- Every `chat` key of an Organization carries that Organization's [Model providers](../../GLOSSARY.md) that are switched on and exist in Bifrost, at their integer weights, and nothing else: a switched-off one is absent and weight 0 makes it a backup ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-chat-keys.md)).
- The backend rewrites them when an admin saves a card on Settings, Model providers ([Model provider](../organization/model-provider.md)), on Project create and, before the claim is finalized, on a pool claim, retrying like the budget patches; a pool slot's own `chat` key has no providers, and a claim whose rewrite keeps failing falls back to the slow path.
- A new Organization starts with a row for each enabled platform provider at its platform weight. In an environment that ran before Model providers, `openai` 0, `anthropic` 1 and `custom-openai-1` 1 route every OpenAI-format request to `custom-openai-1`, the platform's ChatGPT account, whose `base_url` is the in-cluster [Linked-account Proxy](linked-account-proxy.md) once a platform admin signs it in and the hosted [Codex OAuth Dock](../../GLOSSARY.md) until then ([ADR-0018](../adr/0018-linked-account-traffic-goes-through-a-stateless-in-cluster-proxy.md)).
- The `backend` key never follows the Model providers, so the App reaches the real catalogue by role; these are the only provider weights the UI does not own. It defaults to the real OpenAI and Anthropic providers at equal weights; Azure deployments can override it with `BIFROST_UPSTREAM_PROVIDER` and optional `BIFROST_FALLBACK_PROVIDER` (weight 0). The Azure deployment reconciliation script seeds existing project keys; subsequent organization settings updates reconcile chat keys from those settings.
- [Dictation](../projects/dictation.md) rides the `chat` key but pins its model string to the real OpenAI provider ([ADR-0045](../adr/0045-transcription-is-pinned-to-the-real-openai-provider.md)).
- The Bifrost Helm values declare the platform's `openai` and `anthropic`, with keys read from `env.OPENAI_API_KEY` / `env.ANTHROPIC_API_KEY` out of the `opsiforce-bifrost-provider-keys` Secret, and `custom-openai-1`, key-less, at the hosted Codex OAuth Dock in production and the in-cluster Linked-account Proxy locally ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-chat-keys.md)).
- Bifrost runs with the `split` source of truth: nothing its database holds is pruned at startup, and a Helm-declared provider whose values have not changed keeps its database version, so a key replaced, a connection edited or a ChatGPT sign-in written from Settings → Model providers ([Model provider](../organization/model-provider.md)) survives a restart. Every other provider is created, re-keyed and deleted only through the Admin API.
- A fresh install gets its platform rows from the backend's first boot ([Opsiforce model provider](../organization/opsiforce-model-provider.md)), and an environment that ran before Model providers gets them from migration `0074` ([Cut over from Helm](../operations/cutover-from-helm.md)).
- A Model provider row's `bifrost_provider` is its Bifrost provider's name; Bifrost's NetworkPolicy allows egress so the gateway reaches the vendors and the in-cluster Linked-account Proxy.

```
Backend ── Admin API (basic auth) ──▶ Bifrost ◀── LLM calls ── Agent Pod
   │  creates teams / virtual keys      │ real provider keys      │ holds only
   │                                     │ validates virtual keys   │ virtual keys
   └─ injects virtual keys into pod ─────┴── routes to ─▶ OpenAI / Anthropic / custom
```

## Edge cases

- Bifrost is active whenever `BIFROST_PROXY_URL` and admin credentials are set; without them, pods get a direct provider key only if the backend chart supplies one.
- When a Model provider's rewrite cannot reach Bifrost, the Project create fails and is unwound.
- When a Helm-declared provider's entry in the values changes, or a Bifrost upgrade changes how the entry hashes, the file's key reference and URL overwrite what Settings wrote for that provider at the next restart, and only a Connected Linked account such as `custom-openai-1` is pointed back at the proxy, by the backend at its next boot ([Linked account](../organization/linked-account.md)).
- When a Helm-declared provider is removed from the values, it stays in Bifrost's database, and so stays live, until it is deleted through the Admin API.
- A key replaced on Settings for `openai` or `anthropic` is stored as a `plain_text` value in Bifrost's database, while the values keep the `env.*` reference; the Secret's value is then unused until the entry changes.
- The running image is pinned in the Bifrost Helm values (`v2.0.0`); the Admin API payload shapes follow that pin, so verify the running pod image before relying on payload behaviour and back up the `bifrost` database before an upgrade.

## Code

- `backend/src/bifrost/` — the Admin API client: customers, teams, virtual keys, budgets, usage; the `backend` key's fixed provider configs.
- `backend/src/model-provider/` — the Model provider rows, the Base format registry, the fresh-install seed and `writeChatKeys`, which writes each `chat` key's providers.
- `backend/src/pod/pod.template.ts` — virtual key injection into the pod.
- `helm/bifrost/` — chart values with the platform's providers, the image pin and the NetworkPolicy.
- `scripts/store-bifrost-provider-keys.mjs` — the optional key-storing step, rewriting `env.*` key references as `plain_text` values through the Admin API.

## Related

- [Linked-account Proxy](linked-account-proxy.md) — the in-cluster upstream of every signed-in Linked account.
- [Service Gateway](service-gateway.md) — the sibling channel for non-LLM services.
- [Pending project pools](../runtime/pending-project-pools.md) — where orphan teams come from.
- [Defaults](../organization/defaults.md) — the budget defaults caps are seeded from.
- [Dictation](../projects/dictation.md) — the one `chat` call that bypasses rotation.
