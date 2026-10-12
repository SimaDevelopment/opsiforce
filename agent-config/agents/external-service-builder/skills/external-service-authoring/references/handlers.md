# Handlers, `ctx` and unit tests (SDK v1)

## Contents

- The shape of `handlers.ts`
- Operation handlers and `ctx`
- Answers and errors
- Bounds in code
- Secrets and the Service configuration
- Form calls: options, info, buttons
- Save hooks
- `ctx.state`
- Unit tests with the test kit

## The shape of `handlers.ts`

```ts
import { defineHandlers } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';
import { connectionStatus, listBoards, testConnection } from './src/forms.ts';
import { onServiceConfigurationSaved } from './src/hooks.ts';
import { inbound } from './src/inbound.ts';
import { createTask, listTasks } from './src/operations/tasks.ts';

export default defineHandlers<Manifest>({
  manifestHash,
  operations: { list_tasks: listTasks, create_task: createTask },
  options: { listBoards },
  info: { connectionStatus },
  buttons: { testConnection },
  hooks: { onServiceConfigurationSaved },
  inbound,
});
```

Each function in `src/` takes its type from the SDK, so it is checked against the manifest where it is
written:

```ts
import type { OperationHandler } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../../service.types.ts';

export const listTasks: OperationHandler<Manifest, Manifest['operations']['list_tasks']> = async (input, ctx) => { … };
```

The others are `OptionsHandler<Manifest>`, `InfoHandler<Manifest>`, `ButtonHandler<Manifest>`,
`InboundHandler<Manifest>` and `NonNullable<Hooks<Manifest>['onServiceConfigurationSaved']>`.

- `service.types.ts` types every input, both configurations (secrets as `Secret`), the bound names and
  the handler names. `yarn typecheck` catches a handler that no longer fits the manifest.
- Every name the manifest uses needs a handler, and every handler needs a name in the manifest: an
  Operation, an options `call`, an `info.call`, a button `call`, and `inbound` when `"inbound": true`.
  A group the manifest never uses may be left out.
- The service refuses to boot on a missing or undeclared handler, or on a `manifestHash` that is not
  the hash of the `service.json` it serves (a stale `service.types.ts`: run `yarn types`).
- Nothing runs at startup: no configuration fetch, no long-lived upstream connection, no secret on
  disk, no module-level cache that a call depends on. Every call carries what it needs.

## Operation handlers and `ctx`

`(input, ctx) => answer`. The Gate has already checked the switch, the size, the schema and every
bound input, and filled the schema's `default`s.

| Member | What it is |
| --- | --- |
| `ctx.serviceConfiguration` | The Service configuration, opened for this call; `secret` fields are `Secret` objects |
| `ctx.projectConfiguration` | The caller's Project configuration, without `operations`, `receive` and `_labels` |
| `ctx.bounds` | `values`, `has`, `assert`, `filter` (below) |
| `ctx.caller` | `{tenantId, projectId, environmentId, environment, via}`, `via` ∈ `agent`, `app`, `form` |
| `ctx.callId` | The Call log row of this call; put it in your log lines |
| `ctx.signal` | Aborts when the time limit passes; pass it to every `fetch` |
| `ctx.webhookUrl` | This environment's inbound URL (Development has its own) |
| `ctx.log` | `debug`/`info`/`warn`/`error(message, fields?)`, one JSON line each, secrets printed `[secret]` |
| `ctx.state` | The service's small key-value store (below) |
| `ctx.file(bytes, {mimeType, filename?})` | Turns bytes or a string into a file answer |
| `ctx.operation` | The Operation's name |

## Answers and errors

- Return JSON for a `200`, or `ctx.file(…)` for one raw file. Answers are at most 25 MB. Return what
  the agent needs to act next (ids, URLs, the fields it asked for), not the raw upstream payload.
- Throw `new ServiceError({ status, code, detail })` for an answer the caller should read. `code` is
  kebab-case (`task-not-found`) and becomes the problem type `urn:opsiforce:error:<code>`; `detail`
  says what to do next. A `ServiceError` keeps `400`, `404`, `409`, `422`, `429` and `502` (`401` only
  from `inbound`); any other status becomes `502` with the same code. `401` and `403` belong to the
  Gate.
- `rateLimited({ retryAfterSeconds })` answers `429 rate-limited` with `Retry-After`;
  `upstreamUnauthorized(detail?)` answers `502 upstream-unauthorized` when the outside system refuses
  the stored credentials.
- Map upstream failures on purpose: upstream 404 → `404` with your own code, upstream 409/422
  validation → `422`, upstream 429 → `rateLimited`, upstream 401/403 → `upstreamUnauthorized`,
  upstream 5xx → `502` with a code such as `upstream-unavailable`.
- Anything else thrown becomes `502 service-failed` with the `callId` and no stack (the stack goes to
  the log). A wrong answer shape from a form call is `502 service-failed` too. Past the time limit
  (the Operation's `limits.timeoutSeconds`, else 30 s) the caller gets `502 timeout`.

## Bounds in code

The Gate checks ids that are in the input. Two cases are yours, and Stop 1 names them:

- **Indirect ids.** `get_task {taskId}` reaches a task whose board is not in the input. Fetch it, then
  `ctx.bounds.assert('board', task.boardId)`. A refusal is the same `403 out-of-bounds` problem the
  Gate gives. Never answer with the object before the assert.
- **Output filtering.** A search or list that the upstream cannot scope returns
  `ctx.bounds.filter('board', results, 'boardId')`.

`ctx.bounds.values(name)` is the allowed list, or `ALL` while the bound's `unless` holds; use it to
scope the upstream query itself when the API allows. `has(name, value)` answers without throwing.
For a bound with `where`, pass the input as the last argument (`assert('chat', chatId, input)`), so the
matching item is the one the input's pointer names.

## Secrets and the Service configuration

- `secret.reveal()` gives the value; `JSON.stringify`, `String()`, template literals and `ctx.log` print
  `[secret]`. Reveal only where the value goes into the upstream request.
- Never return a secret, a header that carries one, or an upstream error echoing one: the Gate answers
  `502 secret-in-response`.
- A Service form list that a Project form field picks from (`options.serviceConfiguration`) arrives
  trimmed to the items this Project configuration picked. Find the item by the stored id; a missing item
  is a `409` with a code such as `account-missing`. Lists no Project field picks from arrive whole.
- Values stored before a manifest change arrive as the current manifest reads them; an optional field
  may be absent, so default it in code.

## Form calls: options, info, buttons

Run while someone edits a form. 10 s limit, no bounds, no Project configuration, no editor identity;
never write configuration from them.

- `options: { name: ({ query, values }, ctx) => [{ value, label, description? }] }`: at most 50 are
  shown. `values` are the form's unsaved field values, with stored secrets filled in for blank secret
  boxes; the Operations and Receive switches are not among them, so a status that depends on them
  reads what the save hook recorded in `ctx.state` for `ctx.caller.environmentId` (a Project form call
  names the environment being edited). Honour `query` when the field is `searchable`.
- `info: { name: ({ values }, ctx) => ({ text, level? }) }`: a live status line.
- `buttons: { name: ({ values }, ctx) => … }`: answer `{message, level?}`, `{image: {mimeType, base64},
  caption?}` or `{link, label?}`. `level` ∈ `info`, `success`, `warning`, `error`.
- `ctx.form` says which form called (`serviceForm` or `projectForm`).

A "Test connection" button on the Service form is the cheapest way for an admin to know the
credentials work: call the upstream's cheapest authenticated read and answer what it said.

## Save hooks

`hooks.onServiceConfigurationSaved({ previous, current }, ctx)` and
`hooks.onProjectConfigurationSaved({ previous, current }, ctx)` run after the save is committed, with
that call's secrets, for at most 10 s. They never roll the save back: a failure shows "Saved, but …"
with Retry. `current` is `null` when the configuration is deleted (and on Reset of the Test Project);
`previous` is `null` on the first save. Rotate, Publish carry and Delete count as saves. The Project hook
sees `receive` (which Event types this environment switched on), not `operations` or `_labels`, and its
`ctx.caller.environmentId` names the environment whose configuration was saved; the test kit fills it,
and a Project form call's, from the `caller` option.

Use them to register and deregister upstream webhooks (`references/inbound.md`). Make them idempotent:
compare `previous` with `current`, and record what you registered in `ctx.state`.

## `ctx.state`

`get(key)`, `set(key, value)`, `delete(key)`, `list(prefix?)` → `[{key, value}]`, sorted by key. Keys
are 1–256 characters; values are any JSON, and the store is bounded only by the environment's storage.
The SDK keeps it in a SQLite file of the environment this code runs in,
`/workspace/data/service-state.db`, which is never committed and survives restarts. It belongs to the
service, not to a calling Project: every Project's calls share it, so prefix keys with what they belong
to (`webhook:<projectEnvironmentId>`). Each environment has its own file: Development's is yours to test
with, a Publish starts a new environment with none, and switching the Default environment copies the old
Default's file over the new one's. Keep upstream ids and cursors there, never secrets or copies of
upstream data. Never open the file from your own code; go through `ctx.state`.

## Unit tests with the test kit

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testService } from '@opsiforce/external-service-sdk/testing';

import handlers from '../handlers.ts';
import manifest from '../service.json' with { type: 'json' };

const serviceConfiguration = { accounts: [{ id: 'acc_1', label: 'Main', token: 'test-token' }] };

test('create_task refuses a list on a board the Project did not choose', async () => {
  const service = testService(manifest, handlers, {
    serviceConfiguration,
    projectConfiguration: { account: 'acc_1', boardIds: ['B1'], operations: { create_task: true } },
  });
  service.upstream.reply('GET https://api.example.com/lists/L9', { id: 'L9', boardId: 'B2' });

  const answer = await service.call('create_task', { listId: 'L9', name: 'Draft' });

  assert.equal(answer.status, 403);
  assert.equal(answer.problem?.code, 'out-of-bounds');
});
```

- `testService(manifest, handlers, { serviceConfiguration?, projectConfiguration?, caller?, webhookUrl? })`
  boots the same runtime a pod runs, so a missing handler or a stale hash throws here too. Both
  configurations must fit their forms (a `TypeError` otherwise); secrets are plain strings in the test
  and `Secret`s in the handler.
- A `projectConfiguration` with no `operations` gets a new configuration's switches: reads on, writes
  and destructive Operations **off**. Switch on what the test calls.
- `call(op, input, { caller? })` runs the Gate's own checks first, in the Gate's order, with the Gate's
  bodies: `404 unknown-operation`, `403 operation-off`, `413 input-too-large`, `400 invalid-input`
  (with `errors[].pointer`), `403 out-of-bounds`. Every answer is `{status, headers, body, problem,
  callId}`.
- `options(name, { query?, values?, form? })`, `info(name, …)`, `button(name, …)`,
  `hook(name, { previous?, current? })` and `inbound({ method?, headers?, query?, rawBody?, files? })`
  dispatch the other routes.
- `upstream.reply('METHOD https://host/path', answer, { status?, headers? })` answers `fetch`: `answer`
  is JSON, a string, bytes, a `Response` or `(request) => answer`. Method, origin and path must match;
  a query in the route must be a subset of the request's; the last matching reply wins. **Any request no
  reply answers fails the test**, even if the handler swallowed the error. `upstream.requests` records
  `{method, url, headers, body}` for asserting what was sent.
- `state` is the in-memory SQLite store every call's `ctx.state` uses; seed and inspect it. `logs` holds the
  parsed `ctx.log` lines.
- Like the Gate, the kit hands a handler only the Service configuration list items the Project
  configuration picks (for a Project form call, its unsaved `values`; for `onProjectConfigurationSaved`,
  `previous` and `current`), and withholds an answer that contains a secret the call carried as
  `502 secret-in-response`. It does not answer `409 configuration-incomplete`; live tests see that.
- A client that does not use `fetch` (a database driver, a mail protocol) cannot be intercepted: test
  its logic around a seam you control, and check the client itself live.

What every service's unit tests cover is in `review-stops.md` §Testing.
