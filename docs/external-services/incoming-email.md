---
kind: explanation
---

# Incoming Email

> How does a ProjectEnvironment get a receiving email address, and what happens when mail arrives at it?

## How it works

- Every [ProjectEnvironment](../../CONTEXT.md) can have its own address, a random 16-character local part on the deployment's receiving domain; mail to it is verified, stored in the environment's database with attachments inline, metered and announced by the doorbell ([Service template](service-template.md)). Sending mail is a different feature.
- An address is a one-to-one mapping held in the service's configuration document, issued eagerly by the provisioning hook the moment the environment row exists.
- The Agent reaches two environment-scoped endpoints at the `EXTERNAL_SERVICES_URL` base with the [Service Gateway](../gateways/service-gateway.md) token: `GET agent/incoming-email/identity` returns `{address}`, creating it on first call, and `POST agent/incoming-email/regenerate` rotates it.
- The random local part is the entire access model: no inbox password, no sender allowlist, so the address is unguessable and rotatable; rotation is immediate, the old address bounces and stored mail is untouched.
- [Development](../../CONTEXT.md) and each published environment have separate addresses; a [Publish](../projects/publish.md) provisions the new environment its own address and never copies one.
- Mailgun holds the receiving domain's MX records, parses the MIME and forwards each message as one POST of the parsed message with attachments as file parts; the platform never parses MIME or fetches anything.
- The receiving domain is separate from the sending domain and carries one catch-all Route forwarding every recipient to the webhook URL, so a new address works the instant its row exists; the backend is configured with the domain and the account's webhook signing key.
- Verification is Mailgun's HMAC over two form fields, checked in constant time against the signing key; routing lowercases the `recipient` field and matches it against the configuration documents; deduplication keys on the message id, falling back to the signature token.
- A stored row promotes recipient, envelope sender and Mailgun's `stripped-text`; the `From` header, subject, both bodies and the full header list sit in `payload`, and attachments are child rows.
- The `incoming-email` skill teaches the Agent to fetch the address from the identity endpoint and tell the user, replace the template's 501 stub with a real handler, read the shared tables with a `service = 'incoming-email'` filter including the catch-up query, and never hard-code the address.

## Edge cases

- When no signing key is configured, address issuance and the webhook both answer 503.
- When Mailgun is not configured at environment creation, the environment is born without an address and the first identity call creates it.
- When the recipient matches no environment, the handler answers 406 and Mailgun bounces the sender and stops retrying.
- When a POST is redelivered, nothing is written.

## Code

- `backend/src/external-services/incoming-email/incoming-email.definition.ts` — verification, routing, row mapping, the identity projection and the regenerate route.
- `backend/src/external-services/incoming-email/incoming-email-address.service.ts` — issuance and rotation.
- `agent-config/skills/incoming-email/SKILL.md` — the App-side half.

## Related

- [Service template](service-template.md) — the pipeline, storage, doorbell and metering this plugs into.
- [WhatsApp](whatsapp.md) — the other shipped service, with operator-assigned identity.
- [Service Gateway](../gateways/service-gateway.md) — the token the address endpoints ride.
