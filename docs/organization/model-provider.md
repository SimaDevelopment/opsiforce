---
kind: explanation
terms: [Model provider, Base format]
adrs: [0077]
---

# Model provider

> How does an Organization choose where its model requests go, and how does that choice reach its Agents?

## How it works

- A [Model provider](../../CONTEXT.md) is a Bifrost provider plus one `model_providers` row holding only its switch and integer weight; its key, URL and [Base format](../../CONTEXT.md) are read from Bifrost ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-chat-keys.md)).
- Settings, Model providers shows one card per Base format, OpenAI then Anthropic, listing the Organization's rows of that format; an [Opsiforce model provider](../../CONTEXT.md) carries a Built-in pill and shows only its name, status, weight, share and switch, plus its URL and ⋮ menu to platform admins ([Opsiforce model provider](opsiforce-model-provider.md)), and a [Custom model provider](../../CONTEXT.md) is one the Organization added itself ([Custom model provider](custom-model-provider.md)).
- A row's share is its weight divided by the sum of the weights of the format's rows that take requests (on, in Bifrost and, for a Linked account, connected), "Backup" at weight 0, "None" for a row that is on but takes none, and "Off" when switched off. When every row taking requests weighs 0, the first one listed shows 100%, because Bifrost then sends every request to the first entry of the key; a failing row names the other rows taking requests, which Bifrost retries its failed requests on.
- Status comes from the same rule the `chat` keys follow: Not signed in or Needs sign-in again for a Linked account that isn't connected, otherwise Working or Failing from Bifrost's `provider_status`, Missing when Bifrost has no such provider, and Unknown when Bifrost cannot be reached; rows whose provider is missing sit outside the cards, because only Bifrost knows their Base format.
- Switches and weights in a card are a draft with Discard and Save, and Save sends the card in one request; the backend refuses weights outside 0–100, rows of another format, and a format whose rows that are on are all at weight 0, while switching every row off is allowed.
- A save writes the rows and rewrites every `chat` key of the Organization in one transaction under the platform advisory lock, shared, and the Organization's own; for an Opsiforce model provider it writes the Organization's row only when the values differ from the platform's and removes it when they match, so a key that refuses the new split fails the save and leaves the rows as they were. The change applies from the next request with no pod restart ([LLM Gateway](../gateways/llm-gateway.md)).
- A Base format is reachable when at least one of its rows is on, present in Bifrost and, for a [Linked account](../../CONTEXT.md), connected, computed on every read with no cache. `GET /api/model-providers/reachable-formats` answers any member of the Organization with only those format ids (e.g. `["openai"]`), and it feeds the chat's model picker, which hides the other formats' models ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-chat-keys.md)).
- The same reachability filters the Agent Profile model catalog, refuses changing a Profile's model to an unreachable one ([Agent](../agent-system/agent.md)), and decides whether [Dictation](../projects/dictation.md) is available.
- A save that would leave its format with no reachable row answers 409 `agents_affected`, listing the Custom Agents whose Profiles name a model of that format and the Built-in Agents whose Agent Model is in it; the page shows them in a warning dialog. "Save anyway" re-sends the card with `acknowledgeAffectedAgents`, which saves it unchanged, and when no Agent uses the format the save goes through without a warning.
- The format cards and their routes need `can_manage_tenant_model_providers`, except the reachable-formats read; there is no public API route, and a request carrying a gateway key is refused even with a permitted human's headers ([Permissions](permissions.md)).
- The tab shows when a member holds either model-provider permission: the Organization permission gives the cards their Organization rows, switches and weights, and the platform permission alone gives the same cards with only the platform's providers and their menus.

## Edge cases

- When Bifrost cannot be reached, every status reads Unknown, the page shows the rows read-only, and every save answers 503.
- When Bifrost is not configured or cannot be read, every Base format counts as reachable, so the pickers keep their models.
- When a Model provider is missing from Bifrost, it gets no traffic and no card, and its switch and weight are kept.

## Code

- `backend/src/model-provider/` — the rows, the Base format registry, the format cards' routes, reachability and the projection into `chat` keys.
- `frontend/src/pages/model-providers/` — the Settings page, its format cards, the switch-off warning and the share and weight-rule arithmetic.
- `frontend/src/components/project/opencode-overrides.tsx` — the chat picker's model-visibility override that hides unreachable formats.

## Related

- [Custom model provider](custom-model-provider.md) — adding, editing, re-entering and deleting the Organization's own providers.
- [Opsiforce model provider](opsiforce-model-provider.md) — the platform providers and what platform admins manage on the cards.
- [Linked account](linked-account.md) — signing a Vendor account in as a Model provider.
- [LLM Gateway](../gateways/llm-gateway.md) — the virtual keys the rows are projected into.
- [Settings](settings.md) — where the section sits and how it is gated.
- [Permissions](permissions.md) — the permissions and their Keycloak groups.
