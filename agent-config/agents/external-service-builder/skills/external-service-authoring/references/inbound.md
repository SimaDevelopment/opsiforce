# Inbound: Events the service delivers (SDK 2)

When the upstream reports things that happen (an issue opened, a card moved, a message received), the
service turns them into **Events** and hands each to the ProjectEnvironments that asked for it. The
service decides who receives what; the platform only checks that each receiver is connected to the
service, stores the Event in that environment's `external-services.db` and rings its App.

## Contents

- Agreeing the Events with the person
- Declaring them
- The Webhook address
- The webhook handler
- Choosing receivers and delivering
- Sources without webhooks: a poll loop
- Testing inbound

## Agreeing the Events with the person

At Stop 1, out loud: which Event types the service offers, when each arrives, the keys its `data`
carries, and **how a Project chooses what it hears**. A Project hears nothing it did not choose:

- an opt-in Project-form field, empty by default, for a chatty source (a `multiselect` "Notify on:
  card created, card moved");
- plus the targets it already has (only the boards in its Boards setting).

Propose the field; the person decides.

## Declaring them

In `service.json`: `"inbound": true` (without it the Webhook address answers *not supported*) and one
entry per type, a title and a description only:

```json
"events": {
  "card.moved": { "title": "Card moved", "description": "A card moved to another list on a board." }
}
```

Types are dotted `snake_case` (`card.moved`, at most four segments, 100 characters). The shape of each
type's `data` goes in the Service skill, where App agents read it (`references/service-skill.md`).

## The Webhook address

The upstream posts to the platform's own address for this service, which never moves:

- the service's: `https://<main host>/api/external-services/webhooks/<service id>`, reaching whichever
  environment callers use;
- Development's: the same with `/development` after it, delivering only to this chat's Test Project.
  Read it from `development.webhookUrl` in `GET $SERVICE_GATEWAY_URL/_builder`.

Show it to the admin in the Service form with an `info` field, `{ "key": "webhookAddress", "type": "info",
"label": "Webhook address", "template": "{{webhookUrl}}" }`, and say in its `help` where to paste it
upstream and which events to tick. The service's code reads the address of the copy it runs in as
`service.webhookUrl` (Development's own under `dev`), so a save hook can register it through the
upstream's API; when the upstream has none, the person registers it. An upstream that allows one
webhook address per app needs a second app for Development, which Stop 1 says.

Anything may post there: any method, any path after the address, any query. The platform drops
`Cookie`, keeps every other header (`Authorization` included) and sandboxes the answer, so what you
answer there cannot act as a signed-in user.

## The webhook handler

`webhook: (request, ctx) => Response | undefined` on `defineService`, in `src/inbound.ts`. The whole
handler, from signature check to delivery, is `references/patterns.md` §9.

- `request` is what the upstream sent: its method, headers and body untouched, and a URL whose path is
  what followed the Webhook address (`/` when nothing did) plus the query.
- `ctx` has the whole saved `serviceConfiguration` (no Project is known yet), `state`, `service` and
  `note`, and `upstream.fetch(ctx, …)` works for a follow-up read.
- **Verify first**, over the exact bytes received (`request.text()` or `request.arrayBuffer()`, never
  re-serialised JSON), with the upstream's own scheme, comparing in constant time. With several
  accounts in a Service-form list, pick the item by what the request names, then verify with its
  secret.
- Return a `Response` only to refuse (a bad signature) or to answer a handshake the upstream expects
  (echoing a challenge on a verification `GET`). Return nothing otherwise: the SDK answers `200` when
  every delivery was `stored` or `duplicate`, else `503` with `Retry-After: 60`, so the upstream retries
  and the Event `key` drops the repeats.
- A ping or a kind of notification the service does not offer delivers nothing.

## Choosing receivers and delivering

Filter `service.projectConfigurations()` on what the Event is about and on the opt-in field, then
`service.deliver(event, { to })` the ids that remain (`references/patterns.md` §9).

- `service.projectConfigurations()` lists every connected ProjectEnvironment of this copy with its
  settings: the Test Project's for Development, every other one for the service callers use.
- **A wrong receiver leaks one Project's data to another**, and the platform cannot tell. Match on the
  target the Event is about and on the opt-in field, never deliver to all.
- `deliver(event, { to })`: `type` a declared type, `key` the upstream's delivery or event id (1–500
  characters; one Event per service, type, `key` and receiver is stored), `occurredAt` the upstream's
  ISO time, `data` a JSON object, `files?: [{ name, mimeType, bytes }]` (25 MB a file, 20 files, 30 MB
  in all). `to` lists 1–100 ProjectEnvironment ids.
- It resolves to one result per receiver: `stored`, `duplicate`, `not-connected` (it has no Project
  configuration any more) or `over-cap` (more than 60 deliveries to it from this service in a minute).
  Others still store. Any `not-connected` or `over-cap` turns the request's Call log row *failed* with
  the receivers named, and the default answer becomes the `503` above. The SDK retries nothing.
- Each `stored` result adds to the built-in `events` counter of that receiver.

## Sources without webhooks: a poll loop

```ts
background: async (service, signal) => {
  while (!signal.aborted) {
    await pollOnce(service);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
},
```

`background` runs while the service is served, never in tests. `pollOnce(service)` reads what changed
since the cursor it keeps in `service.state` (resume a little before the last change and let the `key`
drop repeats), picks receivers and delivers as above, and moves the cursor only after the upstream
answered. Test `pollOnce(kit.service)` directly with an upstream fake.

## Testing inbound

- **Unit**: post a recorded payload signed with the test's placeholder secret to the kit; the kit sends
  `/.well-known/opsiforce/webhook…` as the platform. Seed receivers with `projectConfigurations`, read
  `kit.deliveries`, and make a receiver `over-cap` with `deliveryResults`:

  ```ts
  const kit = testService(service, {
    serviceConfiguration: { signingSecret: 'test-signing' },
    projectConfigurations: [
      { projectId: 'p1', projectEnvironmentId: 'pe1', projectConfiguration: { boards: [{ id: 'i1', boardId: 'B1' }], notifyOn: ['card.moved'] } },
      { projectId: 'p2', projectEnvironmentId: 'pe2', projectConfiguration: { boards: [{ id: 'i2', boardId: 'B1' }], notifyOn: [] } },
    ],
  });
  const answer = await kit.fetch('/.well-known/opsiforce/webhook', { method: 'POST', headers: { 'x-signature': signed }, body });
  assert.equal(answer.status, 200);
  assert.deepEqual(kit.deliveries.map((delivery) => delivery.to), [['pe1']]);
  ```

  Cover: each Event type delivered to the receivers that chose it and to no one else, a bad signature
  refused, a handshake answered.
- **Live, on your own**: post to Development's Webhook address yourself with `curl` to prove a bad
  signature is refused and a handshake answered; each leaves a `webhook` row in Development's Call log.
- **Live, from the upstream**: the person registers Development's Webhook address on a test target the
  brief names, and you trigger each Event type there (or ask them to). The evidence is the Test Project's Event
  (`GET $SERVICE_GATEWAY_URL/_builder/test-project/events?limit=50`) and the webhook's row in
  Development's Call log (route `webhook`, `references/testing.md`). With no test target, the Event lines
  are not checked, with that reason.
