---
name: whatsapp
description: Let the app RECEIVE WhatsApp messages — texts, photos, documents and voice notes from allowlisted individual chats and groups. Use when the user wants to send data to their app over WhatsApp, log a group's messages, or asks why WhatsApp messages are not arriving. This is INBOUND only — the app cannot send or reply on WhatsApp.
---

# WhatsApp

A WhatsApp number connected to the platform can feed messages into an app. Messages from **allowlisted chats** — an individual conversation or a group — are received by the platform, stored durably in the environment's `external-services.db` (media **bytes included**), and the platform then rings a "doorbell" endpoint on the app so it can react immediately.

Storage does not depend on the app: messages land in SQLite even while the pod is stopped, the handler is unimplemented, or the app is broken. Nothing is lost; the app catches up by reading rows it has not processed.

**Inbound only.** The app cannot send WhatsApp messages or reply in the chat — there is no outbound WhatsApp path in the platform. If the user wants the app to answer in WhatsApp, say so plainly and offer an in-app alternative (a dashboard, a status page, a notification list).

## Connecting a number and a chat is platform-admin work — you cannot do it

This is the important difference from `incoming-email`, where the app can get itself an address. **There is no endpoint that lets you connect a WhatsApp number or allowlist a chat.** A platform administrator does that wiring: they register the number as a channel and allowlist the specific chats — each individual conversation or group — for **this** project environment.

Until a chat is allowlisted to this environment, its messages are received by the platform and silently dropped for this app: nothing appears in `external-services.db`. That is the single most common reason "WhatsApp isn't working".

When the user wants WhatsApp and nothing is wired yet, say plainly that a platform administrator has to connect the number and allowlist their chats to this environment. Everything below — the handler and the read code — you can build **before** that happens. Build it, then tell the user what still needs an admin.

## Which chats are wired — ask the platform

You can't *change* the wiring, but you can *see* it. The shared discovery call every external service answers returns this environment's channels and their allowlisted chats:

```bash
curl -s "$EXTERNAL_SERVICES_URL/whatsapp/identity" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
# {"channels":[{"channelId":"ABC123","label":"Sales number","allowedChats":[
#   {"chatId":"49170...@s.whatsapp.net","chatName":"Anna"},
#   {"chatId":"1203...@g.us","chatName":"Order group"}]}]}
```

It **always returns 200** — an environment with nothing wired gets `{"channels": []}`, never a 404 — so make one unconditional call with no status branching. Credentials never appear in the response.

This is the authoritative answer to "is this chat connected?", and it includes chats that have been allowlisted but have never sent anything (which the stored data cannot show you). Use it to tell the user exactly what is connected, and to name the specific chat still missing when they expect messages that aren't arriving.

Note the fan-out: one chat may feed several environments, and **publishing copies the chat allowlist to the published environment** once that version is live, so a published app receives the same chats as Development without anyone re-allowlisting.

## Wiring the app to react in real time

One step: implement the handler. The platform rings **every** app for **every** stored batch — there is nothing to declare and nothing to opt into.

The app template ships a catch-all stub at `app/backend/src/external-services/external-services.controller.ts`, registered in `app.module.ts`, that answers **501 Not Implemented** for any service. Leave it in place and add a concrete route above it for the service you are implementing (`DoorbellNotification` ships alongside it in `doorbell-notification.ts`):

```typescript
@Post("whatsapp")
async whatsapp(@Body() notification: DoorbellNotification): Promise<{ received: true }> {
  await this.whatsappIntakeService.process(notification.rowIds)
  return { received: true }
}
```

The contract:

- The platform POSTs `/api/external-services/whatsapp` on the app. Returning **2xx** is what makes the app "wired"; the stub's 501 means "not implemented", and those rows simply stay undelivered for the catch-up read to find.
- Body is **notification-only**: `{ "service": "whatsapp", "rowIds": [12, 13, 14] }`. No message content rides the POST — read the rows from SQLite (below). That way the live path and the catch-up path run the same code.
- **`rowIds` is regularly more than one.** The provider batches several messages into one webhook, so write the handler as a loop over ids from the start.
- **Single fire-and-forget attempt, ~10 s timeout, no retries.** A cold or absent pod is simply missed; the platform does not wake the pod for it.
- **Return 2xx quickly.** A 2xx is what stamps `app_delivered_at` on those rows. If the handler is slow, errors, or the pod is down, the rows stay `app_delivered_at IS NULL` and are picked up by the catch-up read.
- **Make processing idempotent.** A row can be handed to the app more than once (e.g. the handler finished but the response never landed). Key your own app data off the message's row `id` — a `UNIQUE` column in `app.db` — rather than trusting the doorbell to fire exactly once.

## Reading stored messages

`/workspace/data/external-services.db` is read-only and its tables appear with the first message — the `platform` skill (§Inbound messages). The app's own data still lives in `app.db`.

All services share **one `messages` table and one `attachments` table**, so every query needs `service = 'whatsapp'`. For WhatsApp:

| Column | Notes |
|---|---|
| `id` | the value that arrives in the doorbell's `rowIds` |
| `service` | always `'whatsapp'` for these rows — **filter on it** |
| `received_at`, `raw_payload`, `app_delivered_at` | platform convention columns; `raw_payload` is the provider's full message JSON |
| `provider_message_id` | unique per service — a redelivered or replayed message is a no-op, not a duplicate row |
| `routing_key` | the chat id. Suffix tells you which kind: `…@s.whatsapp.net` = individual, `…@g.us` = group |
| `sender` | the sender's number — in a group this is the individual member, not the group |
| `text_body` | the message's text — a text message's body, or a media message's caption; `NULL` only when there is neither |
| `payload` | JSON with everything else, read via `json_extract` |

The WhatsApp `payload` JSON holds: `channel_id`, `chat_name` (display-name snapshot, may be null), `from_me` (`true` for messages **sent from the connected number itself** — filter these out unless you want them), `from_name`, `type` (`text`, `image`, `document`, `voice`, `video`, …), `sent_at` (when the sender sent it, ISO; `received_at` is when the platform stored it), `source` (the sender's client), `caption` (a media message's text as the provider sent it — also promoted into `text_body`), `media_id`, and `media_fetch_failed`.

Media arrives as **attachment rows**, exactly like email attachments — there are no media columns on the message:

| Column | Notes |
|---|---|
| `message_id` | FK to `messages.id` |
| `filename`, `content_type`, `size_bytes` | `content_type` is what tells you it's a photo, a PDF, a voice note; select these without `content` to inspect media cheaply |
| `content` | the raw bytes (`BLOB`), `NULL` if the platform's fetch from the provider failed |

Worth designing around:

- **`content` can be `NULL` on an attachment row.** The platform fetches the bytes from the provider before storing; if that fetch fails the row survives with its metadata and no bytes (and `payload.media_fetch_failed` is `true`), so the app can say "photo, 2.1 MB, unavailable" instead of showing nothing. There is no way to re-fetch from the app.

```typescript
import { DatabaseSync } from "node:sqlite"

const inbound = new DatabaseSync("/workspace/data/external-services.db", { readOnly: true })

const messages = inbound
  .prepare(
    `SELECT id, received_at, routing_key, sender, text_body,
            json_extract(payload, '$.chat_name') AS chat_name,
            json_extract(payload, '$.from_name') AS from_name,
            json_extract(payload, '$.type')      AS type
       FROM messages
      WHERE service = 'whatsapp'
        AND id IN (${rowIds.map(() => "?").join(", ")})
        AND json_extract(payload, '$.from_me') = 0`
  )
  .all(...rowIds)

const media = inbound
  .prepare("SELECT filename, content_type, size_bytes, content FROM attachments WHERE message_id = ?")
  .all(messageId)
```

**Catching up** — the same read, driven by the undelivered marker instead of `rowIds`. Worth running on boot and from a `schedules` job, so a missed doorbell is invisible to the user:

```sql
SELECT * FROM messages WHERE service = 'whatsapp' AND app_delivered_at IS NULL ORDER BY id;
```

`app_delivered_at` is backend-owned — the app does not write it, and it stays `NULL` until a doorbell POST gets a 2xx. Keep your own "processed" marker in `app.db` if you need certainty about what the app has actually handled.

### Debugging missing messages

Inspect from the shell without touching app code:

```bash
sqlite3 -readonly -header -column /workspace/data/external-services.db \
  "SELECT id, received_at, routing_key, json_extract(payload, '\$.from_name') AS from_name,
          json_extract(payload, '\$.type') AS type, app_delivered_at
     FROM messages WHERE service = 'whatsapp' ORDER BY id DESC LIMIT 10;"
```

- **"no such table" or no rows at all** → nothing has ever been routed to this environment. Check the identity call above: if it returns `{"channels": []}`, this is platform configuration, not app code — the number may not be registered, or the chat is not allowlisted to this environment. Tell the user a platform administrator has to fix that; don't debug the handler.
- **Rows from some chats but not the one the user means** → compare the identity call's `allowedChats` against what they expect; a missing chat is the admin's to add. Same hand-off.
- **Rows exist, `app_delivered_at` is NULL** → storage worked, the app was not (successfully) rung. Either the handler isn't implemented yet (the template stub answers 501), it returned a non-2xx, or the pod was down when the message landed. The rows are still there — process them with the catch-up read.
- **An attachment row with `content` NULL** → the provider media fetch failed for that message. The text/metadata is intact; there is no way to re-fetch the bytes from the app.
- Rows are also browsable in the DB viewer, which serves `external-services.db` read-only alongside the other databases.
