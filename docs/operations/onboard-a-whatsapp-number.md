---
kind: operations
---

# Onboard a WhatsApp number

> Connect a WhatsApp number to the platform and wire its chats to a ProjectEnvironment.

## Prerequisites

- `can_manage_external_services`, a platform-operator permission held outside the admin bundle ([Permissions](../organization/permissions.md)).
- A Whapi account and the phone that holds the number.
- For a local backend, `EXTERNAL_SERVICES_WEBHOOK_BASE_URL` set to a tunnel origin and the backend restarted, since the webhook delivery URL is always the deployment's webhook base plus the fixed service path ([WhatsApp](../external-services/whatsapp.md)).

## Steps

1. Create the channel in the provider dashboard and link the number by QR code (on the phone: WhatsApp, Settings, Linked devices). The channel must reach an authorised state before it delivers anything.
2. Register it under Admin, External services: paste the channel id and API token and give it a label that carries the human context, since channels are platform-global. The platform generates the webhook secret, never shows it, and pushes the webhook configuration to the provider there and then.
3. Allowlist chats from the project page: the environment dropdown's External services item opens a per-environment dialog that enumerates the channel's chats and groups through the stored token, with validated manual entry as a fallback. Until this step names an environment, that environment receives nothing.
4. If the badge reports drift or the registration-time push failed, use rotate: it re-sends the full webhook configuration, merging with entries that are not the platform's own.

## Verify

- The channel row's webhook badge shows the configuration as pushed.
- `GET $EXTERNAL_SERVICES_URL/whatsapp/identity` from the environment's pod lists the channel and its allowlisted chats.
- A message sent in an allowlisted chat appears as a row in the environment's `external-services.db`.
