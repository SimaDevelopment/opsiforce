---
kind: operations
---

# Onboard a WhatsApp number

> Connect a WhatsApp number to the deployment and let a ProjectEnvironment receive its chats.

## Prerequisites

- `can_manage_platform_external_services`, a platform-operator permission held outside the admin bundle ([Permissions](../organization/permissions.md)).
- A Whapi account and the phone that holds the number.
- `OPSIFORCE_PUBLIC_URL` set; for a local backend, a tunnel origin in the package's `.env` and the backend restarted, since the webhook URL Whapi is given is always the deployment's public URL plus the fixed service path ([WhatsApp](../external-services/whatsapp.md)).

## Steps

1. Create the channel in the Whapi dashboard and copy its channel ID and API token.
2. Open Store, External Services, WhatsApp, and its Service configuration. Add an item to Numbers: the channel ID, a label that says whose number it is (every Organization picks numbers by this label) and the API token. Save. The platform generates the webhook secret, shows it once, and registers the webhook with Whapi; "Saved, but …" means Whapi refused or was unreachable: fix the token or the API URL and press Retry.
3. Press "Show QR code" on the number and scan it on the phone (WhatsApp, Settings, Linked devices) before the code expires. The button says when the number is already linked.
4. In the Project, open WhatsApp under External services below the chat (needs `can_configure_project_external_services`): add a number, pick its chats from the searchable list and save. Until then that environment receives nothing.
5. When the webhook status line warns (another secret, another URL, no webhook, or no `messages` event), Rotate the number's webhook secret: it registers the webhook again.

## Verify

- The number's webhook status line reads "Registered with Whapi".
- `GET https://whatsapp.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce` from the environment's pod shows the number and chats under `configuration.channels`.
- A message sent in one of those chats appears as a `message.received` row in the environment's `external-services.db` `events` table.
