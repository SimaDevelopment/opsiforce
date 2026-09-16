---
kind: explanation
---

# Defaults

> What do platform and [Organization](../../CONTEXT.md) defaults seed into new entities, and what do they leave out?

## How it works

- Defaults seed new entities at creation and never change existing [Projects](../../CONTEXT.md), keys or pods: editing a tenant's default budget affects the next Project created under it.
- Two tiers: global defaults are the platform baseline, and each tenant gets a copy on creation that can diverge; a tenant with no row falls back to the global value.
- Configurable values are the two idle timeouts (agent, app) and the budgets at tenant, Project and per-key level, each with a reset period; the seeded budgets become Bifrost caps ([LLM Gateway](../gateways/llm-gateway.md)).
- Edited under Settings, Defaults, with a New organizations tab for the platform baseline behind `can_manage_platform_defaults` and a New projects tab for this Organization behind `can_manage_tenant_defaults` ([Settings](settings.md), [Permissions](permissions.md)).
- The database is the single source of truth: changing seed values for future deployments is a migration that updates the rows.
- The [Agent Model](../../CONTEXT.md) is not a default; it lives with the Agent profile and is uniform across tenants ([Agent](../agent-system/agent.md)).

## Code

- `backend/src/defaults/` — the two tiers, fallback and the endpoints.
- `frontend/src/pages/defaults.tsx` — the two tabs.

## Related

- [Agent](../agent-system/agent.md) — where the model lives instead.
- [LLM Gateway](../gateways/llm-gateway.md) — how seeded budgets become caps.
- [Settings](settings.md) — the section.
