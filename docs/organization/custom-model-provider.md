---
kind: explanation
terms: [Custom model provider, Official API key, Compatible endpoint]
---

# Custom model provider

> How does an Organization add, change and remove a Model provider of its own?

## How it works

### Adding

- **Add model provider** on a Base format card opens a dialog: Connect with ([Official API key](../../CONTEXT.md), [Compatible endpoint](../../CONTEXT.md), or on the OpenAI card only [Linked account](../../CONTEXT.md)), a name, a base URL for a Compatible endpoint, and a write-only key. Save unlocks only after **Test connection** passes for the current inputs, and `GET /api/model-providers/creation-rules` lists the kinds each format allows, which the backend enforces.
- A Compatible endpoint's base URL is the one the format's own client takes as its base URL: for OpenAI format it usually ends in `/v1` (Azure: `https://<resource>.openai.azure.com/openai/v1/`, with deployments named after model ids), and for Anthropic format it is the root in front of `/v1/messages`. The test calls `<base URL>/models` for OpenAI format and `<base URL>/v1/models` for Anthropic format.
- The create flow is one sequence for the keyed kinds: validate the name and the limit of 10 [Custom model providers](../../CONTEXT.md), create the Bifrost provider first, call the test URL with the key, add the key, insert the row switched on at weight 1, then rewrite every `chat` key. The Test button runs the same sequence up to the call and then removes the provider.
- A Linked account has no key and no test; its create and sign-in are on the [Linked account](linked-account.md) page.
- Any failure after the Bifrost create deletes the provider and confirms the delete with a GET, because Bifrost's `DELETE` answers 200 even when it keeps the provider; an unconfirmed delete answers 502.
- The test never follows a redirect, gives up after 10 seconds and never returns the reply body: 401 or 403 reads "The key was rejected", a 3xx "Enter the final URL", no answer "Can't reach this address", and anything else its HTTP status.
- A base URL must be `https://` and is refused by the backend otherwise, before Bifrost is called ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-chat-keys.md)); Bifrost then checks it itself, and its refusal (for example of a private address) is shown to the admin word for word. The provider gets the URL with `allow_private_network: false` and never a `proxy_config`.

### The Bifrost provider and its name

- Every provider the module creates is named `<tenants.name>-<name>`, takes its `base_provider_type` and `allowed_requests` from the registry (native `/v1/responses` for an OpenAI Official API key; `responses` off on an OpenAI Compatible endpoint, so Bifrost translates Responses calls to `<base URL>/chat/completions` through `request_path_overrides`; Anthropic format always native), and has `list_models` off, 20 workers with a 200-request queue and the standard `network_config` (1200 s request timeout, 2 retries, 3600 s stream idle timeout). Its one key is sent as `{"value", "type": "plain_text"}` with the format's whole catalog as its model list, as the ids opencode sends, mode ids such as `gpt-5.6-sol-fast` included.
- A managed provider's model list follows `agent-config/models.json`: at every backend boot each key of every `model_providers` provider (Custom, `opsiforce-*`, Linked accounts, and `custom-openai-1` once signed in) whose `models` differ from its Base format's catalog is rewritten in place with only `models` changed; the standard `openai` / `anthropic` keys (`["*"]`) are left alone, and a provider Bifrost refuses or can't reach is retried at the next boot without holding up the others.
- A name is a lowercase slug `[a-z0-9-]` of at most `49 − len(tenants.name)` characters, which the dialog shows with a note that it can't be changed; standard Bifrost provider names and names containing `bedrock`, `cohere`, `together`, `vertex_ai`, `fireworks_ai` or `runwayml` are refused, and so is every name of an Organization whose own name contains one. A full name that any `model_providers` row already holds, in this Organization, another one or the platform, reads as taken, even while its Bifrost provider is missing.

### After saving

- A Custom row shows its kind chip, a Compatible endpoint's base URL, and a ⋮ menu whose Delete rewrites the `chat` keys without it, deletes the Bifrost provider and confirms with a GET. The kind is a Linked account when the row owns a `linked_accounts` row and is otherwise read from Bifrost (no `base_url` is an Official API key, the Linked-account Proxy's Service URL is a Linked account, any other is a Compatible endpoint); Built-in rows have neither the chip nor the menu, and the key is never returned.
- **Edit connection** in the ⋮ menu (`PATCH /api/model-providers/:name`) takes a key, which the re-test needs because only Bifrost holds the current one, and for a Compatible endpoint a base URL. A new URL is written to the Bifrost provider first, so Bifrost checks it, then the test runs with the key, then the provider's one key is replaced in place (`PUT /api/providers/{p}/keys/{id}` with the whole key); a failed test or key write puts the old URL back and leaves the old key, and the name, Base format and kind are refused.
- A Custom row whose Bifrost provider is missing shows **Re-enter key** on the row and in its ⋮ menu. `POST /api/model-providers/:name/re-enter-key` takes the Base format, the kind, the key and the base URL again and runs the create flow under the same name without touching the row, so its switch and weight come back as they were; until it passes, the row stays out of every `chat` key.
- Every route finds a row by the Organization and the full name together, so a name another Organization's provider shares answers 404.

## Edge cases

- A missing Custom row can still be deleted, and Edit connection on it answers 409 pointing to Re-enter key.
- When Bifrost answers a delete but keeps the provider, the row is restored, the `chat` keys are rewritten back, and the delete answers 502.
- An admin can add an eleventh Custom model provider only after deleting one; the dialog says so instead of showing the form.
- Bifrost refuses every key write on a key-less provider, so the key-less `custom-openai-1` at the [Codex OAuth Dock](../../CONTEXT.md) serves only the models its Helm entry lists. Once it is signed in, Bifrost still keeps that entry's empty `placeholder` key beside the `lap_…` key; the boot skips it, and Bifrost never routes to it.

## Code

- `backend/src/model-provider/model-provider-creation.service.ts` — the Organization side of the create, test, edit, re-enter key and delete flows.
- `backend/src/model-provider/model-provider-connections.service.ts` — the Bifrost side of those flows.
- `backend/src/model-provider/bifrost-provider-shape.ts` — the provider and key it creates.
- `backend/src/model-provider/model-provider-key-models.service.ts` — the boot-time refresh of key model lists.
- `backend/src/model-provider/provider-names.ts` — the name rules.
- `frontend/src/pages/model-providers/` — the add, edit connection and re-enter key dialogs.

## Related

- [Model provider](model-provider.md) — the format cards, switches, weights and reachability.
- [Linked account](linked-account.md) — the kind that signs in instead of taking a key.
- [Opsiforce model provider](opsiforce-model-provider.md) — global `opsiforce-*` providers, which reuse these flows.
