# Inbound: webhooks into Events (SDK v1)

A service that receives webhooks declares `"inbound": true` and its Event types
(`references/manifest.md` §Events), and implements one handler, `inbound(request, ctx)`, that
**verifies and parses**. The platform does everything after it: it validates each Event's `data`,
picks the receiving ProjectEnvironments by the same bounds the Gate uses, stores the Event in each
one's `events` table and wakes its App. Without `"inbound": true` the webhook URL answers 404.

## The URL

- `ctx.webhookUrl` is the URL the outside system must call. Show it to the admin with an `info` field
  on the Service form: `{ "key": "callback", "type": "info", "template": "{{webhookUrl}}" }`.
- Development has its own URL (ending in `/development`), and its Events reach only this chat's Test
  Project. Before the first Publish it is the only URL that receives anything.
- A provider that allows one webhook URL per app needs a second app for Development; say so in Stop 1.

## The handler

```ts
inbound: async (request, ctx) => {
  const signature = request.headers['x-provider-signature'] ?? '';
  const secret = ctx.serviceConfiguration.signingSecret?.reveal() ?? '';
  if (!signatureMatches(request.rawBody, signature, secret)) {
    throw new ServiceError({ status: 401, code: 'invalid-signature', detail: 'The signature does not match.' });
  }
  const payload = request.body as ProviderPayload;
  return {
    events: [{ type: 'task.moved', key: payload.deliveryId, occurredAt: payload.time,
               data: { boardId: payload.board.id, taskId: payload.task.id } }],
  };
},
```

`request` is what the platform's front door received:

| Field | What it is |
| --- | --- |
| `method` | The HTTP method |
| `headers` | Header names in lower case |
| `query` | The query string |
| `rawBody` | The exact bytes; verify signatures over these, never over re-serialized JSON |
| `body` | `rawBody` parsed for JSON and form-encoded requests, otherwise `undefined` |
| `files` | Multipart files `[{field?, filename, mimeType, bytes}]` |

`ctx` has the **whole** Service configuration (no list is trimmed, since no Project is known yet),
`callId`, `signal`, `webhookUrl`, `log` and `state`; there is no Project configuration, no bounds and no
caller. The limit is 30 s.

- **Verify first.** Compute the provider's signature with a `secret` field of the Service form and
  compare in constant time (`timingSafeEqual` from `node:crypto`). With several accounts in a Service
  form list, pick the item by what the request says (an account id header, a path in the body), then
  verify with that item's secret. A request that fails throws `ServiceError` with status `401`, the one
  place a service may answer `401`.
- **One Event per thing that happened.** `type` is a declared Event type; `key` (1–500 characters) is
  the provider's delivery or event id, because the platform stores one Event per service, type and
  `key` and drops repeats; `occurredAt` is an ISO 8601 time from the provider; `data` fits the type's
  declared schema; `files?: [{name, mimeType, bytes}]` carries attachments.
- **Return `{ events: [] }`** for pings and for kinds of notification the manifest does not declare.
- **`response`** (`{status?, headers?, body?}`) is what the provider gets back, for providers that expect
  a particular answer, such as echoing a verification challenge. Without it the provider gets 200.
- Events whose `data` does not fit are dropped and logged `invalid_event`; an Event no environment
  matches is logged `unmatched` and the provider still gets 200.
- Caps at the front door: JSON 5 MB; multipart 25 MB per file, 20 files, 30 MB in all.

## Who receives an Event

An environment receives a type only while its Project configuration switched that type on (`receive`,
off by default, new types arrive off) **and** every `boundTo` value in the Event's `data` passes the
bound against that configuration. So bind the property that says what the Event is about (the board,
the mailbox, the chat). An unbound type in a Custom service reaches every environment of the
Organization that switched it on.

The receiving App reads `/workspace/data/external-services.db` (`events`, `event_files`); that is the
App author's side and the `platform` skill's subject, not this service's.

## Registering webhooks upstream

When the outside system needs a webhook registered per account, per board or per mailbox, do it in the
save hooks (`references/handlers.md` §Save hooks):

- `onProjectConfigurationSaved`: register for what `current` chose while `current.receive[type]` is on;
  deregister what `previous` had and `current` no longer has, and everything when `current` is `null`.
- `onServiceConfigurationSaved`: account-level registration, and re-registration after a Rotate of the
  signing secret.
- Record each upstream webhook id in `ctx.state` under a key naming what it belongs to, so the next save
  can find and remove it. Register to `ctx.webhookUrl`; the platform answers a sender's `HEAD` check of
  it with 200, and a signature computed over the body plus the URL uses that same `ctx.webhookUrl`.
- A hook has 10 s and its failure never undoes the save; keep it to the registration calls.

## Testing inbound

- **Unit:** `service.inbound({ method: 'POST', headers, rawBody })` with a fixture signed by the test's
  placeholder secret; assert the Events. One more test with a bad signature expects `401`. The kit throws
  when an Event's type is undeclared or its `data` does not fit, as the platform would drop it.
- **Live:** every declared Event type delivered once to Development's URL (`development.webhookUrl` in
  `$EXTERNAL_SERVICES_URL/_builder`), by triggering it on a target the brief names or by posting a
  recorded payload signed with Development's secret. The evidence is the Test Project's `events` row
  (`_builder/test-project/events`) and the inbound Call log row, not your handler's log.
