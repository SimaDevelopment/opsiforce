---
kind: explanation
terms: [Azure connection]
---

# Azure connection

> How does an Azure AI Foundry resource become a model provider, for one Organization or for many?

## How it works

- An Azure connection takes the resource's endpoint (`https://<resource>.services.ai.azure.com`, `.openai.azure.com` or `.cognitiveservices.azure.com`, without a path), a key, and the catalog models it serves from both formats. The test calls `<endpoint>/openai/v1/models` with the key in `api-key`.
- It is a key on the gateway's one native `azure` provider, which the first connection creates, holding the endpoint, the models and an alias per renamed deployment (a Claude deployment whose name lacks `claude` is marked as the Anthropic family). It has a row per format its models span, which sits on that format's card, and each row's entry on the Project keys names only that key ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-project-keys.md)).
- Its models serve every catalog model by default, each deployed under its own name. Choosing models offers a **Some deployments have different names** switch, off by default; only when it is on does each chosen model get a deployment name field, and switching it off sends no deployment names. **Edit connection** takes the endpoint and the key again and replaces both on the key, keeping its models; **Choose models** changes the models and deployment names, adds a row for a format they now reach and drops the row of one they no longer do. **Delete** removes its rows, rewrites the keys and deletes its key, leaving the `azure` provider and its other keys. There is no Re-enter key: when its key is gone from Bifrost the rows read Missing, and Edit connection says to delete it and add it again.
- Every Azure connection is added from Settings: a key of the native `azure` provider, with a row per Base format its models span, `bifrost_provider` `azure`, `bifrost_key` the key's name and `base_format` set. Each row sits on its format's card with its own switches and weights, and serves that format's models on its key ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-project-keys.md)).
- Before a new connection's key is added, every Organization's Project keys are rewritten, so no `azure` entry written before Azure connections existed (allowed any key of the provider) can reach the new key; when an Organization's keys refuse, the connection isn't added and the admin is asked to try again. **Edit connection** tests the new endpoint and key first, then rereads and replaces the key under the same lock as **Choose models**, keeping its current models.
- A platform admin's connection is named `opsiforce-<name>`, starts switched off for its Organizations at weight 1, and is offered to every or chosen Organizations like any Built-in ([Model provider access](model-provider-access.md)); an Organization's own is a [Custom model provider](custom-model-provider.md) named `<tenants.name>-<name>`, switched on for Agents and for Apps at weight 1.
- A key the Bifrost Helm values already declare on `azure`, such as the Azure deployment's `azure-foundry`, has no row, so Settings doesn't show it; the Helm `azure` entry stays unchanged while connections exist, because a changed entry makes the file win for that provider at Bifrost's next restart ([Deploy to Azure](../operations/deploy-azure.md)).

## Code

- `backend/src/model-provider/azure-connections.service.ts` — the connection's key on the `azure` provider and its test.
- `backend/src/model-provider/key-model-formats.ts` — the models, endpoint and deployments its key gives each format.
- `frontend/src/pages/model-providers/connection-fields.tsx` — the endpoint field and the model choice with deployment names.

## Related

- [Custom model provider](custom-model-provider.md) — the create, edit and delete flows it shares.
- [Opsiforce model provider](opsiforce-model-provider.md) — Built-ins, which a platform admin's connection is.
- [LLM Gateway](../gateways/llm-gateway.md) — how its entries reach the Project keys.
