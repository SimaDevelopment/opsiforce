---
kind: explanation
---

# WhatsApp

> How does a WhatsApp number feed messages into an App, and what belongs to the platform versus to one environment?

## How it works

### The service and its numbers

- WhatsApp is a [Built-in External Service](../../GLOSSARY.md) written on SDK 2: the folder `external-services/whatsapp/` holds its `service.json`, `service.ts` wiring form calls, the save hook and the `webhook` handler (it has no Service routes, so it only receives), its Service skill `SKILL.md`, `src/` and its tests ([Service manifest](service-manifest.md)): `src/client.ts` calls Whapi, `forms.ts` holds the chat picker, webhook status and QR button, `hooks.ts` registers and removes webhooks, and `webhook.ts` checks the secret, fetches media, picks the receivers and delivers the Events. It runs in the backend behind the [built-ins adapter](call-log.md#built-ins). Nothing sends or replies.
- Its [Service configuration](../../GLOSSARY.md), set by the platform operator on its page under Store, External Services, is the Whapi API URL (`apiUrl`, empty means `https://gate.whapi.cloud`) and the `channels` list: one item per number with the Whapi channel id, a label, the channel's API token (sealed) and a webhook secret the platform generates (sealed, shown once with Copy). It is Available with no numbers at all. Each item shows a webhook status line and a "Show QR code" button.
- Numbers belong to the deployment: every [Organization](../../GLOSSARY.md) can pick any number, and one number picked by two Organizations is one item.
- Removing a number removes it from every Project configuration that picked it, with a one-time notice there, and its save hook takes this deployment's webhook (its URL, or that number's secret) off that channel at Whapi, keeping every other one; clearing the Service configuration does so for every number, and a refusal there is noted on the hook's Call log row while the save stands.

### Registering the webhook

- Saving the Service configuration runs its after-save hook, which registers the webhook with Whapi (`GET` then `PATCH /settings`) for every number that is new or whose channel id, token or webhook secret changed, and for all of them when `apiUrl` changed. It keeps webhooks Whapi holds that are not Opsiforce's and replaces Opsiforce's earlier one.
- The registered URL is always the deployment's public URL (`OPSIFORCE_PUBLIC_URL`) plus `/api/external-services/webhooks/whatsapp`, never the request's `Host` header ([ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)); the webhook carries the number's secret as the `X-Opsiforce-Webhook-Secret` header.
- A confirmed Rotate of a number's webhook secret is a save, so it registers the new secret. When Whapi refuses or cannot be reached for a number, the hook still registers the other numbers, the values stay saved and the page says "Saved, but …" with Retry; the Call log row's reason names the first number that failed.
- The webhook status line reads Whapi's settings with the number's token: registered, another secret, another URL, no webhook, registered without the `messages` event, or why Whapi could not be asked. The QR button asks Whapi for the number's login QR code (`GET /users/login`) and shows it, or says the number is already linked.

### Choosing chats and receiving

- A [ProjectEnvironment](../../GLOSSARY.md)'s [Project configuration](../../GLOSSARY.md) has a `channels` list too: each item picks a number (`channel`, the Service configuration item's id) and its `chats` from a searchable list the service reads from Whapi with that number's token (`listChats`: chats and groups, names as labels). Chat ids carry their kind in the suffix (`@s.whatsapp.net` individual, `@g.us` group). The configurer sets this in the chat bar's WhatsApp dialog.
- Whapi posts batches to the one webhook URL; the Gate's webhook lane forwards them to the adapter and keeps the `X-Opsiforce-Webhook-Secret` header, the one `X-Opsiforce-*` header it lets through. The handler finds the number by the body's `channel_id` and checks the secret header against that number's webhook secret in constant time; a mismatch is 401.
- Each message becomes one `message.received` Event keyed by the WhatsApp message id: `channel` (the item id), `channelId`, `chatId`, `chatName`, `messageId`, `type`, `from`, `fromName`, `fromMe`, `text` (the text or a media caption), `caption`, `sentAt`, `source`, `media` and `message`, the message as Whapi sent it. Media is fetched with the number's token, then from the payload's link, and stored as the Event's file. A file over 32 MB is refused, by its declared length or once the bytes read pass 32 MB, and reading stops there; a webhook's media are fetched together within 20 s, and when both sources fail or the 20 s run out the Event keeps `media.stored: false` and no file.
- The handler picks the receivers itself from `projectConfigurations()`: a ProjectEnvironment receives a message only when one of its items picks that number and lists that chat (`deliver()`, [Event](events.md)). One chat may feed several environments, in any Organization. Each stored Event counts `events` on the service page's Usage.
- A [Publish](../projects/publish.md) copies the Development Project configuration to the published environment; Development keeps its own, so both hear those chats.
- The Agent learns the service from its Service skill `service-whatsapp`, which a ProjectEnvironment receives once the service is enabled in its chat bar, or when its Agent carries it.

### Upgrading from v1

- At boot, when no WhatsApp Service configuration is stored yet, the backend imports the v1 numbers: each `external_service_resource` row is opened the v1 way (sealed without a place) and becomes a `channels` item with a new id, its label (the channel id when it had none), its token and the same webhook secret, each sealed at the item's own place. `WHAPI_API_URL` becomes `apiUrl` when it is not the default. Nothing is registered with Whapi again, so the secret Whapi holds keeps working.
- In the same transaction each environment's v1 chat allowlist becomes its Project configuration: one item per number with its chats, the chat names in `_labels`. Numbers that no longer exist are dropped, and so is a configuration left with none. A stored Service configuration is never overwritten, so this runs once; the v1 tables, the importer and `WHAPI_API_URL` go a release later.
- External Services v2 retired the v1 Built-in Skill `whatsapp`. Once, at boot, every Agent Profile pinning it, on every Environment, pins `service-whatsapp` at its current Version instead, with no [Service settings (Agent)](../../GLOSSARY.md), or just drops the old pin where the profile already carries `service-whatsapp`; a ProjectEnvironment that switched `whatsapp` off has `service-whatsapp` switched off instead. Each Agent swapped gets a Service skill fan-out, so its existing Projects receive `service-whatsapp` and lose `whatsapp`. An Agent import that pins `whatsapp` gets `service-whatsapp` with a note ([Agent copies](../agent-system/agent-copies.md)). The swap goes a release later with the importer.
- An environment wired in v1 (a chat allowlist in the v1 `external_service_config`, even if it never received a message) or whose `external-services.db` already held `messages` rows is a legacy environment and also gets each message as a v1-shaped `messages` row (`routing_key` = chat id, the v1 `payload` fields, `raw_payload` = Whapi's message) with its media as an inline attachment, and `rowIds` in its ring ([Event](events.md)).

## Edge cases

- When no environment listens to a chat, the webhook answers 200 and notes `messagesNoEnvironmentListensTo`; this is the common cause of "WhatsApp isn't working".
- When a receiver is over the Event cap, the webhook answers 503 and Whapi retries; the message id key keeps the other receivers from doubling.
- When a v1 channel's stored value cannot be opened, the importer logs it and leaves that number out; environments wired only to it lose their wiring.
- When `WHAPI_API_URL` does not fit the form, the importer logs it and imports the numbers with the default API URL.

## Code

- `external-services/whatsapp/` — the manifest, `service.ts`, `src/` (`client.ts`, `forms.ts`, `hooks.ts`, `webhook.ts`), the Service skill and the tests per module (`yarn workspace @opsiforce/external-services test`).
- `backend/src/external-services/upgrade/whatsapp-upgrade.ts` — the one-release import of v1 numbers and chat allowlists.
- `backend/src/external-services/upgrade/retired-skill-swap-upgrade.ts` — the one-release swap of `whatsapp` and `incoming-email` pins for their Service skills.
- `backend/src/external-services/legacy/legacy-messages.ts` — the `messages` row a legacy environment gets for each message.

## Related

- [Configuration](configuration.md) — the Forms, saves, Rotate and after-save hooks this relies on.
- [Event](events.md) — the inbound pipeline, the store and the doorbell this plugs into.
- [Incoming Email](incoming-email.md) — the other inbound built-in.
- [Onboard a WhatsApp number](../operations/onboard-a-whatsapp-number.md) — the operator steps.
- [Permissions](../organization/permissions.md) — the external-services permissions.
