---
name: service-incoming-email
description: Give the App an email address it RECEIVES mail at, attachments included. Use when the user wants to email data into their App, asks "what's my App's email address?", or wants the address changed. Inbound only — sending email is not supported (see the send-email skill).
---

# Incoming email

Each environment of a Project can have its own random receiving address, such as `k3p9x2mq7fd41abv@mail.example.com`. Mail sent to it is stored in this environment's `/workspace/data/external-services.db` as an `email.received` Event, attachments as files, and the App is rung so it can react. Storage does not depend on the App: mail lands while the pod is asleep or the handler is missing, and the App catches up by reading what it has not processed.

**Inbound only.** For anything outbound, see `send-email`.

## The address

Read it from the service, never hard-code it:

```bash
curl -s "https://incoming-email.$EXTERNAL_SERVICES_HOST/address" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

- The answer is `{"address": "…"}`. Development and each published environment have different addresses, so an address written into code or content is wrong the moment the App is published.
- `403` with `Opsiforce-Outcome: not connected`: this environment has no address yet. Tell the user to open **Incoming email** under External services, below the chat, and save; the address appears then. The answer's message carries the link to that dialog.
- `404`: incoming email is not set up on this deployment. Say so plainly; never invent an address.
- Tell the user the address in chat. If the App should show its own address, have the App's backend ask for it at request time (`EXTERNAL_SERVICES_HOST` and `SERVICE_GATEWAY_API_KEY` are in its environment) and serve it to the frontend; never expose the key to the frontend.
- Only the user changes the address, with **Rotate** in the same dialog. The old address stops receiving at once and stored mail is untouched. Suggest it when the address leaked or draws spam, and give the user the new one afterwards.

## What an email looks like

One `events` row per email and recipient, `service = 'incoming-email'`, `type = 'email.received'`, `key` = the message id (a redelivered email is not stored twice). `data` (JSON) holds:

| Property                | Notes                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| `address`               | the local part it was sent to                                                   |
| `recipient`             | the full address, lowercased                                                    |
| `from`                  | the envelope sender's address                                                   |
| `fromHeader`            | the `From` header as written, display name included (optional)                  |
| `subject`               | `''` when there is none                                                         |
| `text`                  | the body without quoted replies and signatures — usually the part to parse      |
| `bodyPlain`, `bodyHtml` | the whole bodies (optional)                                                     |
| `messageId`             | the `Message-Id` (optional)                                                     |
| `headers`               | every header as `[{name, value}]`                                               |
| `attachments`           | `[{filename, mimeType, size}]`, in the order of this Event's `event_files` rows |
| `omittedAttachments`    | attachments over the deployment's size limit, not stored                        |

```typescript
import { DatabaseSync } from 'node:sqlite';

const inbound = new DatabaseSync('/workspace/data/external-services.db', { readOnly: true });

const emails = inbound
  .prepare(
    `SELECT id, occurred_at,
            json_extract(data, '$.from') AS sender,
            json_extract(data, '$.subject') AS subject,
            json_extract(data, '$.text') AS text
       FROM events
      WHERE service = 'incoming-email' AND type = 'email.received'
        AND id IN (${eventIds.map(() => '?').join(', ')})`
  )
  .all(...eventIds);

const files = inbound
  .prepare('SELECT name, mime_type, size_bytes, path FROM event_files WHERE event_id = ?')
  .all(emailId);
```

Attachment bytes are files on disk at `event_files.path`; read them with `fs`. Key the App's own records on the Event `id` (a `UNIQUE` column in `app.db`), because a ring can repeat.

## Debugging

```bash
sqlite3 -readonly -header -column /workspace/data/external-services.db \
  "SELECT id, received_at, json_extract(data, '\$.from') AS sender, json_extract(data, '\$.subject') AS subject, app_delivered_at
     FROM events WHERE service = 'incoming-email' ORDER BY id DESC LIMIT 10;"
```

- **No rows** → the mail never reached this environment. Check the sender used the address the service gives _now_ (it may have been rotated).
- **Rows with `app_delivered_at` NULL** → stored, but the App was not rung successfully: the handler is missing (the template answers 501), it failed, or it is still being retried. Process them with the catch-up read.
