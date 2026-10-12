# Patterns

Generic answers to questions most services meet. The vendor names below only illustrate a rule; the
Built-in External Services in `/opt/agents/external-service-builder/reference/<name>/` are the worked
examples.

## Contents

- Choosing Operations
- Several accounts in one Organization
- Choosing bounds
- Indirect ids and output filtering
- Pagination and large answers
- Changes since last time
- Rate limits, retries and upstream failures
- Connection checks and live status
- Webhook registration
- Files
- Clients that are not `fetch`
- Wrapping an existing OpenAPI document
- Upgrading the vendored SDK

## Choosing Operations

- Scope to the purposes the brief names: a core set, with the rest of the system's capabilities listed
  under "Not in this version" at Stop 1. One service covers one outside system and account; a new
  purpose for the same system grows this service (new Operations arrive off in existing Projects)
  rather than starting a second one.
- One Operation per task a caller has, named for that task (`create_task`, `search_messages`), not one
  per upstream endpoint and never a generic `request` that forwards any path: the Gate can only guard
  what the manifest names.
- Split by kind (`manifest.md` §Operations defines the three). A read that can also write (an
  "upsert") is a write.
- Keep inputs to what the caller decides. Values every call shares (a base URL, an account) belong in
  the forms; values the service can look up belong in the handler.
- Fewer, well-described Operations beat many thin ones: each description is what the calling agent
  reads to choose.

## Several accounts in one Organization

When the Organization may connect more than one account (workspaces, numbers, mailboxes):

- the Service form holds a `list` with a `label` and the account's secrets per item;
- the Project form has a `select` with `options: {serviceConfiguration: "<list key>", labelKey: "label"}`,
  which stores the item's `id`;
- each call then receives only the chosen item, found by that id; a bound on the select (`path` naming
  it) lets inputs and Events carry the account id when they must.

With exactly one account, plain `secret` fields on the Service form are enough.

## Choosing bounds

A bound exists for every kind of id a caller passes that names something the Organization may not
want every Project to reach: boards, repositories, channels, folders, customers.

- The Project form field the bound reads is usually a `multiselect` fed by an options `call`
  (`searchable`, `dependsOn` the account select), so the configurer picks from real names.
- Add a radio such as `mode: selected | all` and `unless: {"mode": "all"}` only when "everything" is a
  real need; "all" must be a choice someone makes, never a default.
- Ids inside lists of a Project form item (a chat inside a chosen channel) use `list[].field` with
  `where` pointing at the input property that names the item.

## Indirect ids and output filtering

- An Operation that takes an id of a child object (a task, a comment, a file) whose parent is the
  bounded thing must fetch the child first and `ctx.bounds.assert` its parent before acting or
  answering. Put the parent's id in the input instead when the caller always knows it: then the Gate
  checks it.
- A search the upstream cannot scope to the allowed set is filtered with `ctx.bounds.filter` before it
  is returned, and the description says results are limited to the Project's choice.
- Both are refusals only your code makes, so both are live test lines (`review-stops.md` §Testing).

## Pagination and large answers

Take a `limit` with a `default` and a `maximum`, and a `cursor` the previous answer returned. Return
`{items, nextCursor}`. Never page through everything in one call: the time limit is 30 s by default and
answers are capped at 25 MB.

## Changes since last time

An Operation that answers "what changed since we last asked" keeps its cursor in `ctx.state`, keyed by
whose "last time" it is (the caller's environment, a board). Upstream ids and timestamps are rarely
strictly ordered within a second, so resuming after the last id or exactly at the last time repeats or
loses events. Resume from a little before the last change and drop the ids already reported, keep the
cursor's shape readable by the next version (the stored state outlives a Publish), and move it only
after the upstream answered.

## Rate limits, retries and upstream failures

- Upstream 429: throw `rateLimited({ retryAfterSeconds })` with the provider's own wait; do not sleep
  and retry inside the call.
- Upstream 401/403 on the stored credentials: `upstreamUnauthorized()`, so the admin learns the token
  needs replacing.
- Retry only idempotent reads, once, inside the time limit, with `ctx.signal`.
- For writes, pass the provider's idempotency key when it has one (derived from `ctx.callId`), so a
  caller's retry does not create twice.

## Connection checks and live status

- A `button` on the Service form (or on each list item) that makes the cheapest authenticated read and
  answers `{message, level}` tells the admin the credentials work before anyone calls the service.
- An `info` field with a `call` shows live status (a webhook registered or not, remaining quota). It runs
  on every form open, so keep it to one cheap upstream call.

## Webhook registration

Use the save hooks and record what you registered in `ctx.state`; `inbound.md` §Registering webhooks
upstream has the rules. When the provider has no registration API, show `{{webhookUrl}}` in an `info`
template and say in the field's `help` where to paste it.

## Files

- Return a file with `ctx.file(bytes, {mimeType, filename})`; that is the whole answer.
- Inputs carry files only as URLs or ids the service fetches; input size is limited (1 MB by default,
  `limits.inputBytes` up to 25 MB).
- Inbound attachments become Event `files`.

## Clients that are not `fetch`

A database driver, an SMTP or IMAP client, or a gRPC client cannot be intercepted by `upstream.reply`.
Keep its calls behind a small function you can replace in unit tests, and check the real client live.
Add its npm package as an ordinary dependency (`yarn add`), commit `yarn.lock`, and keep connections per
call: open, use and close inside the handler.

## Wrapping an existing OpenAPI document

When the outside system publishes an OpenAPI document and callers need a slice of it, `yarn
external-service-cli generate --from-openapi` writes `service.json` from it: each operation becomes an
Operation whose input is one flat object merging the path, query and body parameters (a name used by
two of them fails the generation), plus a generic handler table that forwards the call. Run `yarn
external-service-cli --help` first: the vendored SDK may predate the command (see §Upgrading the
vendored SDK).

The generated file is a draft, not a design:

- keep only the Operations the brief needs;
- check every kind against `manifest.md` §Operations;
- add the bounds and the `boundTo` marks the generator cannot know;
- rewrite each description for an agent that has never seen the API;
- then hold Stop 1 as for a hand-written design.

## Upgrading the vendored SDK

Only after the person agrees (`SKILL.md` §Upgrading the SDK):

1. Read both `CHANGELOG.md` files and tell the person what the new version brings for this service.
2. Copy `/opt/opsiforce/external-service-sdk/external-service-sdk-<new>.tgz` into `vendor/`, point the
   `@opsiforce/external-service-sdk` dependency in `package.json` at `file:./vendor/external-service-sdk-<new>.tgz`,
   remove the old tarball, and run `yarn install`.
3. `yarn types`, `yarn check`, `yarn typecheck`, `yarn test`; rerun the live lines the change touches
   and write a new test report.
4. Commit the tarball, `package.json`, `yarn.lock` and `service.types.ts` together. Callers keep the old
   version until a human publishes.
