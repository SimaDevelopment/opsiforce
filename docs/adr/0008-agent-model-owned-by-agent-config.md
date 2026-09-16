# Agent model is owned by agent-config, not a tenant/platform default

Status: accepted

The platform had two competing stores for "which LLM does the agent run on". `agent-config/agents.json` carries each agent's `model`, which the pod init container injects over the workspace `opencode.json` at startup — this is what actually runs. In parallel, migration `0014` created `global_agent_defaults` and `tenant_agent_defaults` tables with a `default_model` column, a `DefaultsService` read/write API, a `model-registry` of selectable models, and per-tenant seeding on tenant creation — mirroring the two-tier shape used for timeouts and budgets. The DB side was **write-only**: nothing read `default_model` at runtime, no UI ever exposed it, and the seeded value sat inert. Two sources of truth, one of them dead.

**`agent-config` wins; the DB side is removed.** The agent model is a property of the agent profile, uniform across every tenant and project, version-pinned alongside the agent image and skills. It is not something a tenant admin tunes. We dropped both tables (migration `0043`), the four `/defaults/{global,tenant}/agent` endpoints, the agent methods on `DefaultsService`, the `model-registry`, and the dead frontend types. Timeouts and budgets — which *are* read at runtime and seed real per-tenant policy — keep their two-tier defaults untouched.

**Why the asymmetry is deliberate.** Timeouts and budgets are operational knobs that legitimately differ per tenant (a trial tenant on a tight budget, an enterprise tenant on a loose one) and are consumed when projects/keys are created. The model is not an operational knob: changing it alters agent behaviour, prompt-token economics, and context limits in lockstep with the agent's instructions and the `opencode.json` per-model `limit`/`reasoningEffort` config. Splitting the model away from that config into a per-tenant database column invites mismatches (a selected model with no matching context-limit block) and gives no operational benefit, since the platform intentionally runs one vetted model for everyone.

## Considered options

- **Keep both, finish the DB feature** — wire `default_model` into pod creation and build the tenant UI. Rejected: it makes per-tenant model selection a supported product surface we do not want, and it permanently forks the model away from the per-model `limit`/`reasoningEffort` config that lives in `opencode.json`, where the two must stay in step.
- **Keep the tables, stop using them** — leave the dead schema in place. Rejected: a future reader sees timeouts/budgets/model all modelled identically and reasonably "completes" the model path, reintroducing the second source of truth.
- **Reconcile the `model-registry` whitelist instead of deleting it** — keep `AVAILABLE_MODELS` in sync with the `opencode.json` provider whitelist. Rejected: it preserves a registry whose only consumers were the dead endpoints; deleting it removes the sync burden entirely.

## Consequences

- `agent-config/agents.json` is the **single source of truth** for the agent model (see [Agents](../agent-system/agent.md)); the baked default in `opencode.json` / `opencode.local.json` mirrors it.
- [Defaults](../organization/defaults.md) now covers **timeouts and budgets only**. The `can_manage_platform_defaults` / `can_manage_tenant_defaults` permissions are unchanged — they still gate those two.
- Migration `0014` is immutable and still creates the agent tables; `0043` drops them forward. The budget/timeout tables `0014` created are untouched.
- Re-introducing per-tenant or per-project model selection is now an explicit, reversible decision (a new migration + endpoints), not an accidental completion of half-built scaffolding.
