---
name: service-whatsapp
description: Let the App RECEIVE WhatsApp messages — texts, photos, documents and voice notes from chosen individual chats and groups. Use when the user wants to send data to their App over WhatsApp, log a group's messages, or asks why WhatsApp messages are not arriving. Inbound only — the App cannot send or reply on WhatsApp.
---

# WhatsApp

A WhatsApp number connected to the deployment can feed messages into an App. Messages from the **chats this environment listens to** — an individual conversation or a group — are stored in this environment's `/workspace/data/external-services.db` as `message.received` Events, media bytes as files, and the App is rung so it can react. Storage does not depend on the App: messages land while the pod is asleep or the handler is missing, and the App catches up by reading what it has not processed.

**Inbound only.** The App cannot send WhatsApp messages or reply in the chat. If the user wants the App to answer in WhatsApp, say so plainly and offer an in-app alternative (a dashboard, a status page, a notification list).

## Which chats this environment hears — you cannot change it

Picking the number and the chats is the user's work, in **WhatsApp** under External services, below the chat: one item per number, its chats picked from a searchable list. Adding a number to the deployment is the platform operator's work. There is no endpoint that lets you do either.

Read what is wired from the service, never guess:

```bash
curl -s "https://whatsapp.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

- `configuration.channels.value` lists each number (`channel`, the number's item id) with its `chats` (chat ids).
- `403` with `Opsiforce-Outcome: not connected`, or no `channels`: nothing reaches this environment. Tell the user to open **WhatsApp** below the chat, pick the number and chats, and save.
- The number the user means is not offered there: a platform operator has to add it. Say so plainly.
- `404`: WhatsApp is not set up on this deployment.

Everything below — the handler and the read code — you can build before any of that is done. Build it, then tell the user what is still missing.

Publishing copies the numbers and chats to the published environment. Development keeps its own, so both hear those chats until the user removes them from Development.

## What a message looks like

One `events` row per message, `service = 'whatsapp'`, `type = 'message.received'`, `key` = the WhatsApp message id (a redelivered message is not stored twice), `occurred_at` = when it was sent. `data` (JSON) holds:

| Property           | Notes                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `channel`          | the number's item id; `channelId` is the Whapi channel                                                             |
| `chatId`           | `…@s.whatsapp.net` = an individual chat, `…@g.us` = a group                                                        |
| `chatName`         | the chat's display name when WhatsApp sent one                                                                     |
| `from`, `fromName` | the sender's number and name; in a group, the member who wrote                                                     |
| `fromMe`           | `true` for messages **sent from the connected number itself** — filter these out unless you want them              |
| `type`             | `text`, `image`, `document`, `voice`, `video`, …                                                                   |
| `text`             | the text, or a media message's caption; absent when there is neither                                               |
| `sentAt`, `source` | when and from which client it was sent                                                                             |
| `media`            | `{id, mimeType, filename, size, stored}` for a media message; `stored: false` means the bytes could not be fetched |
| `message`          | the message exactly as WhatsApp's gateway sent it (locations, contacts, quoted replies, …)                         |

```typescript
import { DatabaseSync } from 'node:sqlite';

const inbound = new DatabaseSync('/workspace/data/external-services.db', { readOnly: true });

const messages = inbound
  .prepare(
    `SELECT id, occurred_at,
            json_extract(data, '$.chatId') AS chat_id,
            json_extract(data, '$.chatName') AS chat_name,
            json_extract(data, '$.fromName') AS from_name,
            json_extract(data, '$.type') AS type,
            json_extract(data, '$.text') AS text
       FROM events
      WHERE service = 'whatsapp' AND type = 'message.received'
        AND json_extract(data, '$.fromMe') = 0
        AND id IN (${eventIds.map(() => '?').join(', ')})`
  )
  .all(...eventIds);

const media = inbound
  .prepare('SELECT name, mime_type, size_bytes, path FROM event_files WHERE event_id = ?')
  .all(messageId);
```

Media bytes are files on disk at `event_files.path`; read them with `fs`. A media message whose `media.stored` is `false` has no file: show "photo, unavailable" rather than nothing; the App cannot fetch it again. Key the App's own records on the Event `id` (a `UNIQUE` column in `app.db`), because a ring can repeat.

## Debugging

```bash
sqlite3 -readonly -header -column /workspace/data/external-services.db \
  "SELECT id, received_at, json_extract(data, '\$.chatName') AS chat, json_extract(data, '\$.type') AS type, app_delivered_at
     FROM events WHERE service = 'whatsapp' ORDER BY id DESC LIMIT 10;"
```

- **No rows** → nothing reached this environment. Check `/.well-known/opsiforce`: no `channels` or the chat missing from `chats` is the user's to fix in the WhatsApp dialog; a missing number is the platform operator's. Don't debug the handler.
- **Rows from some chats but not the one the user means** → compare `projectConfiguration.channels[].chats` with what they expect and name the missing chat.
- **Rows with `app_delivered_at` NULL** → stored, but the App was not rung successfully: the handler is missing (the template answers 501), it failed, or it is still being retried. Process them with the catch-up read.
- **`media.stored` false** → the media fetch from WhatsApp's gateway failed; the text and metadata are intact.
