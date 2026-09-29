---
name: incoming-email
description: Give the app an email address it can RECEIVE mail at — inbound email with attachments. Use when the user wants to email data into their app, or asks "what's my app's email address?" / wants that address rotated. This is INBOUND only — sending email is not supported (see the send-email skill).
---

# Incoming Email

Every ProjectEnvironment can have its own random receiving address (e.g. `k3p9x2mq7fd41abv@mail.example.com`). Mail sent to it is received by the platform, stored durably in the environment's `external-services.db` — **including attachments** — and the platform then rings a "doorbell" endpoint on the app so it can react immediately.

Storage does not depend on the app: mail lands in SQLite even while the pod is stopped, the handler is unimplemented, or the app is broken. Nothing is lost; the app catches up by reading rows it has not processed.

**Inbound only** — for anything outbound, see `send-email`.

## The address — always fetch it, never hard-code it

Each environment has a **different** address (Development and each published environment are separate), and the address can be rotated at any time. A hard-coded address is wrong the moment the app is published.

```bash
curl -s "$EXTERNAL_SERVICES_URL/incoming-email/identity" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
# {"address":"k3p9x2mq7fd41abv@mail.example.com"}
```

This is the same discovery call every external service answers — `GET $EXTERNAL_SERVICES_URL/<service>/identity` — and for incoming email it has exactly two outcomes: **200 with the address**, or **503 when inbound email is not configured on this deployment**. On a 200 the environment normally already has an address; the call creates one if it somehow doesn't, and returns the same one forever after. The key is environment-scoped, so a 200 always returns *this* environment's address.

- **Tell the user the address in chat** so they can start sending mail to it.
- The address has exactly two homes: chat, and the endpoint above. Keep it out of app code, content, and config.
- If the app should display its own address, have the **app backend** fetch it from the same endpoint at request time (the app runs in this container, so `EXTERNAL_SERVICES_URL` / `SERVICE_GATEWAY_API_KEY` are in `process.env`) and return it from an endpoint the frontend queries. Backend only — never expose the gateway key to the frontend.
- A `503` from this endpoint means inbound email is not configured on this deployment. Say so plainly; don't invent an address.

### Rotating a leaked or spammed address

```bash
curl -s -X POST "$EXTERNAL_SERVICES_URL/incoming-email/regenerate" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

The replacement is immediate and there is no grace period — mail to the old address bounces from that moment. Only regenerate when the user asks (the address leaked, or it is getting spam), and always give them the new one. Already-stored emails are untouched.

## Wiring the app to react in real time

One step: implement the handler. The platform rings **every** app for **every** stored batch — there is nothing to declare and nothing to opt into.

The app template ships a catch-all stub at `app/backend/src/external-services/external-services.controller.ts`, registered in `app.module.ts`, that answers **501 Not Implemented** for any service. Leave it in place and add a concrete route above it for the service you are implementing (`DoorbellNotification` ships alongside it in `doorbell-notification.ts`):

```typescript
@Post("incoming-email")
async incomingEmail(@Body() notification: DoorbellNotification): Promise<{ received: true }> {
  await this.inboundEmailService.process(notification.rowIds)
  return { received: true }
}
```

The contract:

- The platform POSTs `/api/external-services/incoming-email` on the app. Returning **2xx** is what makes the app "wired"; the stub's 501 means "not implemented", and those rows simply stay undelivered for the catch-up read to find.
- Body is **notification-only**: `{ "service": "incoming-email", "rowIds": [12, 13] }`. No email content rides the POST — read the rows from SQLite (below). That way the live path and the catch-up path run the same code.
- **Single fire-and-forget attempt, ~10 s timeout, no retries.** A cold or absent pod is simply missed; the platform does not wake the pod for it.
- **Return 2xx quickly.** A 2xx is what stamps `app_delivered_at` on those rows. If the handler is slow, errors, or the pod is down, the rows stay `app_delivered_at IS NULL` and are picked up by the catch-up read.
- **Make processing idempotent.** A row can be handed to the app more than once (e.g. the handler finished but the response never landed). Key your own app data off the message's row `id` — a `UNIQUE` column in `app.db` — rather than trusting the doorbell to fire exactly once.

## Reading stored emails

`/workspace/data/external-services.db` is read-only and its tables appear with the first message — the `platform` skill (§Inbound messages). The app's own data still lives in `app.db`.

All services share **one `messages` table and one `attachments` table**, so every query needs `service = 'incoming-email'`. For email:

| Column | Notes |
|---|---|
| `id` | the value that arrives in the doorbell's `rowIds` |
| `service` | always `'incoming-email'` for these rows — **filter on it** |
| `received_at`, `raw_payload`, `app_delivered_at` | platform convention columns; `raw_payload` is Mailgun's full form payload as JSON |
| `provider_message_id` | unique per service — a redelivered or replayed email is a no-op, not a duplicate row |
| `routing_key` | the address the mail was sent to (lowercase) |
| `sender` | the envelope sender |
| `text_body` | Mailgun's `stripped-text` — the body with quoted replies and signatures removed, usually the best field to parse |
| `payload` | JSON with everything else, read via `json_extract` |

The email `payload` JSON holds: `from_header` (the raw `From:` header), `subject`, `body_plain`, `body_html`, and `message_headers` (the full header list, itself JSON).

`attachments` — zero or more per email, bytes stored inline:

| Column | Notes |
|---|---|
| `message_id` | FK to `messages.id` |
| `filename`, `content_type`, `size_bytes` | select these without `content` to list attachments cheaply |
| `content` | the raw bytes (`BLOB`) |

```typescript
import { DatabaseSync } from "node:sqlite"

const inbound = new DatabaseSync("/workspace/data/external-services.db", { readOnly: true })

const emails = inbound
  .prepare(
    `SELECT id, received_at, sender, text_body,
            json_extract(payload, '$.subject') AS subject
       FROM messages
      WHERE service = 'incoming-email' AND id IN (${rowIds.map(() => "?").join(", ")})`
  )
  .all(...rowIds)

const attachments = inbound
  .prepare("SELECT id, filename, content_type, size_bytes FROM attachments WHERE message_id = ?")
  .all(emailId)

const { content } = inbound
  .prepare("SELECT content FROM attachments WHERE id = ?")
  .get(attachmentId) as { content: Uint8Array }
```

**Catching up** — the same read, driven by the undelivered marker instead of `rowIds`. Worth running on boot and from a `schedules` job, so a missed doorbell is invisible to the user:

```sql
SELECT * FROM messages WHERE service = 'incoming-email' AND app_delivered_at IS NULL ORDER BY id;
```

`app_delivered_at` is backend-owned — the app does not write it, and it stays `NULL` until a doorbell POST gets a 2xx. Keep your own "processed" marker in `app.db` if you need certainty about what the app has actually handled.

### Debugging inbound mail

Inspect from the shell without touching app code:

```bash
sqlite3 -readonly -header -column /workspace/data/external-services.db \
  "SELECT id, received_at, sender, json_extract(payload, '\$.subject') AS subject, app_delivered_at
     FROM messages WHERE service = 'incoming-email' ORDER BY id DESC LIMIT 10;"
```

- **No rows at all** → the mail never reached this environment. Confirm the sender used the address the endpoint returns *now* (it may have been regenerated, and mail to a dead or unknown address is permanently rejected — the sender gets a bounce).
- **Rows exist, `app_delivered_at` is NULL** → storage worked, the app was not (successfully) rung. Either the handler isn't implemented yet (the template stub answers 501), it returned a non-2xx, or the pod was down when the mail landed. The rows are still there — process them with the catch-up read.
- Rows are also browsable in the DB viewer, which serves `external-services.db` read-only alongside the other databases.
