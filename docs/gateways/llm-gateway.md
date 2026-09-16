---
kind: explanation
adrs: [0003]
---

# LLM Gateway

> How does a [Project](../../CONTEXT.md)'s pod reach an LLM without holding a provider key, and how are budgets enforced across its environments?

## How it works

### Keys and budgets

- Bifrost sits between agent pods and the upstream providers; real provider keys live only in Bifrost's Secret, the backend talks to Bifrost's Admin API with basic auth, and pods receive per-Project virtual keys.
- Each Project has one Bifrost team and two virtual keys distinguished by `key_type`: `chat` for the OpenCode Agent (injected as the OpenAI and Anthropic key and base URL pairs) and `backend` for the built App's own AI features (`APP_LLM_API_KEY`, `APP_LLM_BASE_URL`), which the `llm-api` skill teaches the Agent to use.
- Both keys are shared by every [ProjectEnvironment](../../CONTEXT.md) of the Project; a [Publish](../projects/publish.md) never mints new keys, and the budget cap is anchored on the single team ([ADR-0003](../adr/0003-one-bifrost-team-per-project-keys-per-env.md)).
- Budgets nest Customer (tenant), Team (Project) and Virtual Key, and all three must have remaining budget for a request to proceed; tenants and Projects seed their caps from [Defaults](../organization/defaults.md) at creation and manage them through the Billing UI.
- A [pending project pool](../runtime/pending-project-pools.md) slot carries an orphan team with no customer; the claim patches the team's customer to the claiming tenant and the baked keys stay valid.

### Provider routing

- Each virtual key carries its own candidate providers, picked by weight, and a provider serves only models it offers.
- The `chat` key weights the real OpenAI provider to zero and serves the Agent's default model through three evenly weighted OpenAI-compatible custom providers whose upstream `base_url` lives in the Bifrost Helm values: the team upstream in the monorepo, the host-run [Codex Proxy](codex-proxy.md) or the OpenAI API in the standalone Quickstart ([ADR-0018](../adr/0018-standalone-llm-access-via-codex-proxy.md)).
- The `backend` key routes only to the real OpenAI and Anthropic providers, so the App reaches the real catalogue by role.
- [Dictation](../projects/dictation.md) rides the `chat` key but pins its model string to the real OpenAI provider ([ADR-0045](../adr/0045-transcription-is-pinned-to-the-real-openai-provider.md)).
- The custom provider ids in the Helm values and the provider names in each `chat` key's config are the same strings and stay in lock-step; Bifrost's NetworkPolicy allows egress so the in-cluster gateway can reach the host-run proxy.

```
Backend ── Admin API (basic auth) ──▶ Bifrost ◀── LLM calls ── Agent Pod
   │  creates teams / virtual keys      │ real provider keys      │ holds only
   │                                     │ validates virtual keys   │ virtual keys
   └─ injects virtual keys into pod ─────┴── routes to ─▶ OpenAI / Anthropic / custom
```

## Edge cases

- Bifrost is active whenever `BIFROST_PROXY_URL` and admin credentials are set; without them, pods get a direct provider key only if the backend chart supplies one.
- The running image is pinned in the Bifrost Helm values (`v2.0.0`); the Admin API payload shapes follow that pin, so verify the running pod image before relying on payload behaviour and back up the `bifrost` database before an upgrade.

## Code

- `backend/src/bifrost/` — the Admin API client: customers, teams, virtual keys, budgets, usage; the per-key provider configs.
- `backend/src/pod/pod.template.ts` — virtual key injection into the pod.
- `helm/bifrost/` — chart values, the custom provider upstreams, the image pin and the NetworkPolicy.

## Related

- [Codex Proxy](codex-proxy.md) — the host-run upstream the standalone custom providers point at.
- [Service Gateway](service-gateway.md) — the sibling channel for non-LLM services.
- [Pending project pools](../runtime/pending-project-pools.md) — where orphan teams come from.
- [Defaults](../organization/defaults.md) — the budget defaults caps are seeded from.
- [Dictation](../projects/dictation.md) — the one `chat` call that bypasses rotation.
