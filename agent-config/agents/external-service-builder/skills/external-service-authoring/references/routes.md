# Service routes, upstreams and checks (SDK 2)

## Contents

- `service.ts`
- Routes
- Patterns and order
- Groups
- Upstreams and credentials
- Checks
- Reading the body
- `through`: narrowing a request, filtering an answer
- `handle`: answering without the upstream
- Refusals
- `ctx` and `service`
- `ctx.state`
- Counters and notes

## `service.ts`

```ts
import { allowAll, defineService, route } from '@opsiforce/external-service-sdk';

import manifest from './service.json' with { type: 'json' };
import type { Manifest } from './service.types.ts';
import { routes as cards } from './src/groups/cards.ts';
import { routes as reads } from './src/groups/reads.ts';
import { options } from './src/forms.ts';
import { webhook } from './src/inbound.ts';

export default defineService<Manifest>({
  manifest,
  routes: [
    route<Manifest>('* /v1/boards/:board/automations/**', { summary: 'Board automations are not available through this service' }),
    ...cards,
    ...reads,
  ],
  counters: { cards_created: { label: 'Cards created' } },
  options,
  webhook,
});
```

`defineService` takes `manifest`, `routes` (ordered), and optionally `counters`, `options`, `info`,
`buttons`, `hooks` (`references/handlers.md`), `webhook` (`references/inbound.md`), `background`
(code that runs while the service is served, never in tests) and `refusal` (§Refusals). It throws at
start on an invalid `service.json`, a route not made with `route(…)` or a bad counter, with the reason.

## Routes

`route<Manifest>(pattern, options)` is one row of the table, and `options` decides its kind:

| Kind | Options | What happens |
| --- | --- | --- |
| proxy | `to: <upstream>`, `check` | the check decides; an allowed request goes to the upstream as received, credentials swapped in |
| handle | `handle: (request, ctx) => Response`, `check` | the check decides; the service answers itself (§`handle`) |
| refuse | neither `to` nor `handle` | always *not supported*, with the `summary` as the message |

Every row has:

- `summary`: one line a calling agent reads in `/.well-known/opsiforce` and the Call log shows as the
  route. A row that filters an answer or changes a request says so ("Your boards, only the ones this
  Project is given").
- `allowedBy`: the Project-form keys that govern it (typed from `service.json`), required on every
  row: `[]` when no setting does (a refuse row, an `allowAll` row). Calling agents plan from them, so
  list every setting the check reads.
- `check`: required on proxy and handle rows (§Checks). `allowAll` lets every connected Project through
  and shows `"allowAll": true` to callers and in the code diff reviewers read; use it only for requests
  that reach nothing a setting governs (a client's login probe, a version endpoint), or when `through`
  does the filtering. Write `check: allowAll` itself: a hand-written check that always allows hides
  that from callers and reviewers.
- optional `through` on a proxy row (§`through`) and `bodyLimit` (bytes a check may read, default
  10 MiB, at most 100 MiB).

## Patterns and order

- `'<METHOD> <path>'`, `'GET|HEAD <path>'` or `'* <path>'` for every method.
- `:name` is one whole, non-empty path segment, read as `ctx.params.name` (decoded). It never shares a
  segment with literal text: `/v1/exports/42.csv` matches `/v1/exports/:export` with `export` =
  `42.csv`, so strip the suffix in the check.
- `**` is zero or more segments and only comes last: `/v1/boards/:board/**` matches `/v1/boards/B1` too.
- Matched case-sensitively against the caller's **full path**, mount included (`/api/v1/boards/…`). The
  query string is never matched: read it in the check from `new URL(request.url).searchParams`.
- **First match wins**, and no match is *not supported*. Put refuse rows and narrower rules before the
  wider row they carve out of (archive before "everything on a card"; automations before "everything
  on a board"). A row that can never be reached because an earlier one covers it is a bug.

## Groups

A group is a file, not an SDK object: `src/groups/<group>.ts` exports `routes`, every row in it
governed by the same setting through one helper in `src/access.ts` (`references/patterns.md` has the
access-level helper). The file names match the Stop 1 table, so a reviewer finds each group where the
table said.

```ts
import { route } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../../service.types.ts';
import { needs } from '../access.ts';
import { api } from '../upstreams.ts';

export const routes = [
  route<Manifest>('GET /v1/boards/:board/**', {
    to: api,
    summary: 'Read a board, its lists and cards',
    allowedBy: ['boards'],
    check: (_request, ctx) => needs(ctx, ctx.params.board, 'read', 'Reading a board'),
  }),
];
```

## Upstreams and credentials

`src/upstreams.ts` declares each upstream once:

```ts
export const api = upstream<Manifest>({
  name: 'api',                                   // lower case; shown in /.well-known/opsiforce
  api: 'Boards REST API v1',                     // the upstream's API and version, as its docs name them
  url: ({ serviceConfiguration }) => serviceConfiguration.baseUrl ?? 'https://api.example.com',
  mount: '/api/v1',                              // optional: the caller-path prefix removed before forwarding
  credentials: ({ serviceConfiguration }) => ({ headers: { authorization: `Bearer ${serviceConfiguration.token.reveal()}` } }),
});
```

- `url` is a string, or a function of `{ serviceConfiguration, projectConfiguration }` when the address
  is a setting (a self-hosted or regional upstream, a sandbox). Fall back to the upstream's public
  address when the field is blank, as above, so the public service needs no address typed in. Where a
  client sends what the public service splits across hosts (one host for the API, another for files
  or a protocol), declare one upstream per host, each with its own public default.
- `mount`: callers send `/api/v1/boards/x` and the upstream receives `/boards/x`. Use it when a client
  expects a prefix at a host of its own (an enterprise-host CLI), so one service can carry several
  upstreams on one Service host without their paths colliding.
- `credentials(configurations, outgoing)` returns `{ headers?, query? }`, values strings or `Secret`s,
  and may be `async`. The SDK removes the caller's credential headers and any query key you set first,
  so a key a caller copied from the upstream's docs never wins. Credentials by header, query key or a
  per-Project secret, and short-lived tokens minted from an app key, are in `references/patterns.md`.
- `upstream.fetch(ctx, path, init?)` calls the upstream from your own code with the same credentials:
  `path` is relative to `url`, without the mount. It makes no Call log row, and in tests it reaches the
  same fake as the route. Use it for lookups inside a check and in form handlers.
- A request that reaches an upstream with no fake in a test fails as *failed*: a wrongly allowed
  request shows up as a failing test.

## Checks

`check: (request, ctx) => Verdict | Promise<Verdict>` decides, and only three answers count:

- `ctx.allow()`
- `ctx.notAllowed({ setting, message })`: a setting forbids it; `setting` is a Project-form key.
- `ctx.notSupported(message?)`: the service does not serve this request.

Anything else, `undefined`, `true` or a throw, is *failed* and nothing is forwarded, so a forgotten
branch never lets a request through. Return the verdict of every branch explicitly.

- Read targets from `ctx.params`, the query or the body, and look up anything the request names only
  indirectly (a card id whose board the request does not name) with `upstream.fetch` before allowing it.
- Compare ids exactly as the upstream does (case-insensitive names where the upstream
  treats them so).
- A body-dispatched protocol (GraphQL, JSON-RPC, MCP) is one route whose check parses the body and
  dispatches by operation or method, answering `ctx.notSupported(…)` for anything not listed
  (`references/patterns.md`).

## Reading the body

Bodies stream untouched unless a check, `through` or `handle` reads them. Reading one
(`await request.json()`, `.text()`, `.arrayBuffer()`) buffers it up to the route's `bodyLimit` (over it:
`413`, *failed*), decoded from its `Content-Encoding` for you, and the upstream still receives the bytes
as they arrived. A `Request` body reads once: when `through` reads it too, read it in the check from
`request.clone()`. Leave large uploads (pushes, file uploads) unread unless the policy needs them,
and raise `bodyLimit` on that route when it does.

## `through`: narrowing a request, filtering an answer

`through: (request, ctx, forward) => Response | Verdict` on a proxy row runs after the check.
`forward()` sends the request as received; `forward(new Request(url, request))` sends a changed one
(the path stays under the same route's upstream). It answers the upstream's response, decoded, for you
to pass on, change or replace; the SDK fixes the framing headers after you. Use it to cut a list to
the allowed targets, to narrow a search to them, to refuse on what the answer reveals, or to count only
what succeeded. A route with `through` refuses connection upgrades (WebSocket, SPDY): leave `through`
off the routes that stream or upgrade. Snippets in `references/patterns.md`.

## `handle`: answering without the upstream

Only for one of three reasons, and say which at Stop 1 and in the summary: the upstream has no HTTP API
(SQL, SOAP, a mail protocol); a real client needs a shim at this host (an enterprise-host CLI asking for
a version or `meta` document at login); or the person asked for a convenience after one pushback.
`handle: (request, ctx) => Response | Verdict` returns a `Response`, or a refusal verdict found while
answering. An answer containing a secret of the Service configuration is refused as *failed*
("answer contained a secret"). A `handle` route's request and answer shapes are documented in the Service
skill, since no upstream docs cover them.

## Refusals

| Outcome | Status | Comes from |
| --- | --- | --- |
| *not supported* | 404 | no route matched, a refuse row, `ctx.notSupported`, an unsafe path |
| *not allowed* | 403 | `ctx.notAllowed` |
| *not connected* | 403 | the SDK: no Project configuration |
| *incomplete* | 403 | the SDK: a required field is empty |
| *failed* | 502 (413 over `bodyLimit`) | a check or handler threw or gave no verdict, the upstream was unreachable |
| *unidentified* | 401 | the SDK: no valid Caller identity |

Every answer the SDK makes itself carries `Opsiforce-Outcome: <outcome>` and, when a setting governs
it, `Opsiforce-Setting: <key>`; proxied answers carry neither. The default body is
`{ "outcome", "message", "setting", "link" }` as JSON, which `curl`, SDKs and many CLIs print as is.

**The message.** You write what was refused and what would allow it; the SDK appends the setting's
label and the link to that field in the Project's settings:

```ts
ctx.notAllowed({ setting: 'boards', message: 'Moving a card needs Change cards on board Roadmap; this Project has Read' });
// message: "Moving a card needs Change cards on board Roadmap; this Project has Read. Setting "Boards": https://<base>/projects/p-42?configure=boards-svc&field=boards"
```

- One message per reason, naming the ids involved and the level needed; the calling agent relays it to
  a person who opens the link, so it must make sense on its own.
- When no Project setting can fix it, say whom to ask instead, and leave `setting` out. A Service-form
  problem (a required field missing, a credential the upstream refuses, an address that does not
  answer) is for an Organization admin: "Reading tickets needs the API key, which an Organization admin
  sets on this service's page in Store → External Services". An upstream permission the credential
  lacks is for whoever owns the upstream account. The same code serves Development and the copy
  callers use, so a message never names either.
- The same text is the Call log reason the service page and the Project dialog show.
- A *not supported* message says what the service does not serve ("Workflows are not available through
  this service"), so the agent stops looking for a way around.

**`refusal(refusal, request)`** on `defineService` replaces the body of every refusal the SDK makes,
for clients that print something else: many CLIs print `text/plain` (git shows it as
`remote:` lines), an MCP client expects a JSON-RPC `error`. `refusal` has `outcome`, `status`,
`message`, `setting` and `link`; return a `Response`, or `undefined` to keep the default. Only the body
and its headers are yours: the status and the two `Opsiforce-*` headers stay the SDK's.

## `ctx` and `service`

A check, `through` and `handle` get `ctx`:

| Member | What it is |
| --- | --- |
| `ctx.caller` | `{ kind, tenantId, projectId, projectEnvironmentId, environment }` of the calling ProjectEnvironment |
| `ctx.params` | the pattern's `:name` segments |
| `ctx.projectConfiguration` | the caller's settings, typed from `service.json`; `secret` fields are `Secret`s |
| `ctx.serviceConfiguration` | the whole Service configuration, shared by every Project (use only the items the caller references) |
| `ctx.missingServiceFields` | the required Service-form keys the Service configuration lacks; nothing is refused for them, so a row that cannot work without one refuses itself, naming the field an Organization admin must set |
| `ctx.state` | the service's key-value store (§`ctx.state`) |
| `ctx.service` | the service as a whole (below) |
| `ctx.count(name, n?)` | adds to a declared counter for the caller's Project and environment |
| `ctx.note(fields)` | adds JSON fields to this request's Call log row |
| `ctx.allow()`, `ctx.notAllowed(…)`, `ctx.notSupported(…)` | the verdicts |

`service` (also `ctx.service`, and the first argument of `background`):

| Member | What it is |
| --- | --- |
| `service.configuration()` | the saved Service configuration, for code with no caller |
| `service.projectConfigurations()` | every connected ProjectEnvironment with its settings, `[{ projectId, projectEnvironmentId, projectConfiguration }]` |
| `service.deliver(event, { to })` | hands an Event to chosen ProjectEnvironments (`references/inbound.md`) |
| `service.count(name, n, { projectEnvironment? })` | adds to a counter for a ProjectEnvironment, or for the service as a whole |
| `service.state` | the same store as `ctx.state` |
| `service.webhookUrl` | the Webhook address of the copy this code runs in (Development's under `dev`; `references/inbound.md`) |

Configurations are read once when a request starts and kept by the SDK for at most 5 seconds; a save
anywhere drops the kept copy at once. A `secret` value is a `Secret`: `secret.reveal()` gives the
string, and `JSON.stringify`, `String()` and template literals print `[secret]`. Reveal it only where it
goes into an upstream request.

## `ctx.state`

`get(key)`, `set(key, value)`, `delete(key)`, `list(prefix?)` and `update(key, (current) => next)`.
Values are any JSON, keys 1–256 characters. `update` is atomic per key (calls for the same key run one
after another; return `undefined` to delete), which makes caps race-free. The store is a SQLite file of
the environment the code runs in (`data/service-state.db`), shared by every Project's calls, so prefix
keys with what they belong to (`cards-created:<projectEnvironmentId>:<day>`). Development has its own,
Reset of the Test Project deletes it, and a switch of the Default environment copies the old Default's.
Keep upstream ids, cursors and counts there, never secrets or copies of upstream data, and never open
the file yourself.

## Counters and notes

- Declare counters once in `defineService({ counters: { cards_created: { label: 'Cards created', description: '…' } } })`:
  at most 20, names `snake_case` (`^[a-z][a-z0-9_]{0,62}$`), labels up to 60 characters, never a
  built-in name (`requests`, `not_allowed`, `failed`, `events`).
- `ctx.count('cards_created')` after the thing happened (in `through`, once the upstream answered
  `ok`), `service.count(…)` from code with no caller. An undeclared name or a count outside 1–10⁹
  throws. Counts are monthly, per Project and environment, shown on the service's Usage tab, and never
  limit anything.
- `ctx.note({ method: 'cards.archive' })` adds what a reader of the Call log needs to tell requests
  apart (which GraphQL operation or JSON-RPC method passed). Never a secret, a body or personal data.
