---
kind: explanation
terms: [Opsiforce model provider]
---

# Opsiforce model provider

> Which Model providers does the platform give every Organization, and how does a platform admin manage them?

## How it works

- A platform provider is a `model_providers` row with no `tenant_id`, an [Opsiforce model provider](../../GLOSSARY.md) every Organization has unless it is [withheld](model-provider-access.md) from it; its switches and weights, for Agents and for Apps, are every Organization's values for it until the Organization saves different ones, which become a row of its own with that `tenant_id`. The Organization's row is removed when a save brings it back to the platform's values, so an Organization holds rows only for what it set apart. The UI never edits a platform row's switch or weight.
- There is no separate card: the platform's providers are the Built-in rows of the OpenAI and Anthropic format cards. A holder of `can_manage_platform_model_providers` also sees each one's URL (the vendor's API for an Official API key) and a ⋮ menu on it, while the key stays write-only; their routes live under `/api/platform-model-providers`, are Platform-scope and list no Organization's rows ([Permissions](permissions.md)).
- A platform admin without `can_manage_tenant_model_providers` gets the same cards listing only the platform's providers with their menus, and no switch, weight or Save; the page then never calls an Organization route.
- The fixed `openai` and `anthropic` are standard Bifrost providers that transcription and the backend key depend on: their ⋮ menu offers **Replace key**, re-tested against the vendor's API before it saves, and **Choose models**; they always point at the vendor URL, can't be deleted, and serve every model (`["*"]`, catalog or not) until a platform admin chooses some. When Bifrost has lost one, **Re-enter key** recreates it as a standard provider and rewrites the `chat` keys of every Organization that has it.
- **Add model provider** on a format card asks platform admins **Who can use it**: **Only this organization** (the Organization's own dialog, offered only with the Organization permission), **Every organization**, including ones added later, or **Only organizations I choose**, picked in a searchable list, which later Organizations don't get until a platform admin gives them access. Either of the last two creates an `opsiforce-<name>` provider (at most 40 characters after the prefix) of the card's Base format with the Organization dialog's Official API key, Compatible endpoint, Linked account or [Azure connection](azure-connection.md) and its create, edit connection, re-enter key and delete code ([Custom model provider](custom-model-provider.md)), and the `availability` in the create request (`{ "mode": "every" }` or `{ "mode": "chosen", "tenantIds": [...] }`) starts its availability ([Model provider access](model-provider-access.md)).
- An `opsiforce-*` provider other than an Azure connection carries a "Not metered" pill, because Bifrost prices a custom provider at $0 against every budget, while an Azure connection is a key of the native `azure` provider, which Bifrost prices. Its platform rows are switched off at weight 1, so it reaches its Organizations switched off without touching any `chat` key, and each Organization's own admin decides whether it takes traffic.
- **Choose models**, on every Built-in that has a key, is `PUT /api/platform-model-providers/<name>/models` with `{ models }` (`null` for every model, and `deployments` for an Azure connection). It writes only the key's models, keeping the stored secret, and rewrites every Organization's keys; when some Organization's keys refuse, it says so and saving again retries. On the fixed `openai` and `anthropic` the dialog notes that a change to their Helm entry replaces the choice, since Bifrost then reloads them from the values.
- The ⋮ menu of an `opsiforce-*` provider offers **Edit connection** (Official API key, Compatible endpoint and Azure connection) and **Delete**. **Delete** says it is removed from every Organization, then deletes its platform rows, every Organization's own rows of it and its availability, rewrites every Organization's `chat` keys and deletes the Bifrost provider, confirmed with a GET, or for an Azure connection only its key.
- A platform [Linked account](../../GLOSSARY.md) row shows platform admins a **Sign in** link beside its status and, in its ⋮ menu, **Sign in with ChatGPT** and **Paste access token** until it is connected and **Sign in again** and **Disconnect** after ([Linked account](linked-account.md)).
- `custom-openai-1` is the platform's Linked account, always listed on the OpenAI card to platform admins, even before it has a platform row or a Bifrost provider. When its first sign-in creates its platform row, switched on at weight 1, the same transaction rewrites every Organization's `chat` keys to take it ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-project-keys.md)).
- Creating an Organization named `opsiforce` or starting with `opsiforce-` is refused, since its Custom model providers would be named like the platform's.
- **Fresh-install seed:** at boot, when no platform row exists and Bifrost is configured, as on a fresh install, whose migration creates no rows, the backend gives `openai` and `anthropic` platform rows switched on at weight 1 each, under a platform advisory lock: one Bifrost already has, as the Helm values declare it, is adopted with its key untouched, and one it lacks is created from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, only when set, through the same create code (test, key, row). Once any platform row exists it never runs again, and it never seeds a Linked account.

## Edge cases

- A platform provider missing from Bifrost reads Missing under "Not in the model gateway", where a platform admin re-enters its key, and every sync leaves it out of every Organization's `chat` keys until its key is re-entered.

## Code

- `backend/src/model-provider/platform-model-providers.service.ts` — the platform side of the flows, the global create and the fresh-install seed.
- `backend/src/model-provider/model-provider.service.ts` — an Organization's rows over the platform's, and the Organization's own rows a save writes.
- `frontend/src/pages/model-providers/built-in-row.tsx` — a platform admin's URL, sign-in controls and ⋮ menu on Built-in rows.

## Related

- [Model provider](model-provider.md) — the format cards an Organization switches and weights these rows on.
- [Custom model provider](custom-model-provider.md) — the create, edit, re-enter key and delete flows a global provider reuses.
- [Model provider access](model-provider-access.md) — which Organizations get each of these.
- [Azure connection](azure-connection.md) — Azure AI Foundry resources added as Built-ins.
- [Linked account](linked-account.md) — the `custom-openai-1` sign-in.
- [Permissions](permissions.md) — the platform permission and its Keycloak group.
