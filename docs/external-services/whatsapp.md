---
kind: explanation
---

# WhatsApp

> How does a WhatsApp number feed messages into an App, and what belongs to the platform versus to one environment?

## How it works

### Channels and allowlists

- A number connects to the platform as a channel through Whapi, which links the number by QR code; messages from allowlisted chats are verified, stored in the target environment's database with media bytes, metered and announced by the doorbell ([Service template](service-template.md)). Nothing sends or replies.
- A channel is a platform-global resource row: the provider's channel id, the API token an operator pasted, a server-generated webhook secret and a human label, with no tenant column, so one number shared by two [Organizations](../../CONTEXT.md) is one row.
- Resource values are encrypted at rest with AES-256-GCM under a key from the environment; the token is used outbound (enumerating chats, configuring the webhook, fetching media) and the secret is pushed to the provider, echoed back as a header on every delivery, and never shown to an operator again.
- Each [ProjectEnvironment](../../CONTEXT.md) has one configuration document listing the channels it listens to and the allowlisted chats under each; nothing arrives by default and there is no wildcard. Chat ids carry their kind in the suffix (`@s.whatsapp.net` individual, `@g.us` group).
- Fan-out is allowed: one chat may appear in several environments' documents, each stored and metered independently.
- The document cascades away with its environment while the channel survives; Duplication and Import copy nothing; a [Publish](../projects/publish.md) copies the document to the published environment once that version is healthy, as an idempotent upsert.

### Ingest

- Whapi posts batches mixing individual and group messages and does not sign them; verification compares the secret header in constant time against the secret stored for that channel id.
- Each message is routed by chat id; a non-allowlisted chat is accepted and dropped.
- Media arrives as a reference and is fetched before storing, with the channel's token and the payload's temporary link as fallback; it becomes an attachment row and a caption is promoted into the text column.
- Deduplication keys on the provider's message id.

### Webhook and management

- The platform configures the provider's webhook itself: the delivery URL is always the deployment's webhook base (`EXTERNAL_SERVICES_WEBHOOK_BASE_URL`) plus the fixed service path, and every mutation that changes what the provider should hold (registration, token correction, secret rotation) pushes the full configuration, merging with entries that are not its own.
- Channels are registered under Admin, External services, gated by `can_manage_external_services`; chats are allowlisted per environment from the environment dropdown's External services dialog, which enumerates the channel's chats through the stored token ([Onboard a WhatsApp number](../operations/onboard-a-whatsapp-number.md)).
- The `whatsapp` skill teaches the Agent to replace the template's 501 stub, read the shared tables with a `service = 'whatsapp'` filter, and see the wiring through `GET agent/whatsapp/identity`.

## Edge cases

- When a chat is not allowlisted for any environment, the platform answers 200 and stores nothing; this is the common cause of "WhatsApp isn't working".
- When an unknown channel posts or the secret mismatches, the handler answers 406.
- When both media fetches fail, the attachment row is written with null bytes and the failure logged.
- When the webhook push fails at registration, the channel stays registered and the badge shows what is missing; rotate re-sends the full configuration and is the repair action.
- When a rotation cannot reach the provider, it fails and keeps the old secret.
- When a Publish never comes online, the published environment's existing document is untouched.

## Code

- `backend/src/external-services/whatsapp/whatsapp.definition.ts` — verification, routing, media fetch, publish carry, identity and the admin route table.
- `backend/src/external-services/whatsapp/whatsapp-channel.service.ts` — the operator surface and the webhook push.
- `backend/src/external-services/whatsapp/whapi.client.ts` — provider calls.
- `externalServiceResource` in `backend/db/schema.ts` — channel credentials.
- `frontend/src/pages/external-services-admin.tsx` — the Admin registration page.
- `agent-config/skills/whatsapp/SKILL.md` — the App-side half.

## Related

- [Service template](service-template.md) — the pipeline, storage, doorbell and metering this plugs into.
- [Incoming Email](incoming-email.md) — the other shipped service, with self-served identity.
- [Onboard a WhatsApp number](../operations/onboard-a-whatsapp-number.md) — the operator steps.
- [Admin](../organization/admin.md) — the section the registration page lives in.
- [Permissions](../organization/permissions.md) — the external-services permissions.
