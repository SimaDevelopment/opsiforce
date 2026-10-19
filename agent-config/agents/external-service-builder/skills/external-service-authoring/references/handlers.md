# Form handlers and save hooks (SDK 2)

Named handlers the platform calls while someone edits or saves a form. They never run for a Service
route, and no caller reaches them: the platform calls them under the SDK's `/.well-known/opsiforce/`
prefix.

## Contents

- Options, info and buttons
- Which configuration a handler sees
- Save hooks
- Trying them: the probes
- Testing them

## Options, info and buttons

A field in `service.json` names the handler (`references/manifest.md`): `options: { call: "listBoards" }`
on a `select`, `multiselect` or `radio`, `{ "type": "info", "call": "connectionStatus" }`, or
`{ "type": "button", "call": "testConnection" }`. `service.ts` passes them by name:

```ts
import type { ServiceDefinition } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';
import { api } from './upstreams.ts';

export const options: ServiceDefinition<Manifest>['options'] = {
  listBoards: async ({ query }, ctx) => {
    const answer = await api.fetch(ctx, '/v1/me/boards');
    if (!answer.ok) return [];
    const boards = (await answer.json()) as { id: string; name: string }[];
    return boards
      .filter((board) => board.name.toLowerCase().includes(query.toLowerCase()))
      .map((board) => ({ value: board.id, label: board.name }));
  },
};
```

| Kind | Called as | Answers |
| --- | --- | --- |
| `options` | `(draft, ctx)`, `draft` = `{ form, values, query, item? }` | `[{ value, label, description? }]`; the first 50 are shown; honour `query` when the field is `searchable` |
| `info` | `(draft, ctx)`, `draft` = `{ form, values, item? }` | `{ text, level? }`, a live status line |
| `buttons` | `(draft, ctx)` | `{ message, level? }`, `{ image: { mimeType, base64 }, caption? }` (png, jpeg, gif or webp, at most 1 MB) or `{ link, label? }` |

`level` is `info`, `success`, `warning` or `error`. `item` is the list item's id when the field sits in
a list. A handler that throws answers *failed* and the form shows it; an answer holding a secret of the
Service configuration is refused. Handlers never write a configuration and never learn who is editing.

A **Test connection** button on the Service form is the cheapest way for an admin to know the
credentials work: make the upstream's cheapest authenticated read with the values just typed and
answer what it said. An `info` field with a `call` runs on every form open; keep it to one cheap call.

## Which configuration a handler sees

- `draft.values` is the form's **unsaved** draft, with stored secrets filled in for secret boxes left
  blank.
- A **Project-form** handler sees the saved Service configuration as `ctx.serviceConfiguration` and the
  saved Project configuration (or `null`) as `ctx.projectConfiguration`; the draft is only in
  `draft.values`. `ctx.caller.projectEnvironmentId` names the environment being edited.
- A **Service-form** handler sees the draft itself as `ctx.serviceConfiguration`, so
  `api.fetch(ctx, …)` tries the credentials just typed; `ctx.projectConfiguration` is `null`.
  `service.configuration()` stays the saved copy.
- `ctx.form` says which form called. `ctx` also has `state`, `service` and `note`.

## Save hooks

```ts
export const hooks: ServiceDefinition<Manifest>['hooks'] = {
  async onProjectConfigurationSaved({ current }, ctx) {
    const boards = (current?.boards ?? []).map((entry) => entry.boardId);
    await ctx.state.set(`boards:${ctx.caller.projectEnvironmentId}`, boards);
  },
};
```

`previous` is `null` on the first save, `current` is `null` when the configuration is gone.

- `onServiceConfigurationSaved({ previous, current }, ctx)` runs after every save of the Service
  configuration, a Rotate of a generated secret included.
- `onProjectConfigurationSaved({ previous, current }, ctx)` runs for one ProjectEnvironment
  (`ctx.caller.projectEnvironmentId`) after a save, a cascade, a Publish carrying Development's values
  forward, a Disconnect, the environment's removal, the service's Delete and the Test Project's Reset;
  `current` is `null` for the last four.
- Declare only the hooks the service needs: the SDK answers an undeclared one itself and drops its kept
  configurations either way, so the next request reads the new values.
- A hook has 10 seconds and runs after the save is committed: its failure never undoes the save, the
  form shows "Saved, but …" with Retry. Make it idempotent: compare `previous` with `current`, and keep
  what you set up upstream (a webhook id, a subscription) in `ctx.state` under a key naming what it
  belongs to, so the next save finds and removes it.

## Trying them: the probes

The builder lane runs your handlers as the platform would (`references/testing.md` has the lane):

```sh
LANE="$SERVICE_GATEWAY_URL/_builder"; AUTH="Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
# a Project-form handler, as the Test Project, on the draft you send (needs a Test Project)
curl -s -H "$AUTH" -H 'content-type: application/json' -d '{"values":{},"query":"sprint"}' "$LANE/probe/options/listBoards"
# a Service-form handler, on Development's saved Service configuration with your values laid over it
curl -s -H "$AUTH" -H 'content-type: application/json' -d '{}' "$LANE/probe/service/buttons/testConnection"
```

The route word is `options`, `info` or `buttons`; a name no field of that form calls is
`404 unknown-callback`. In the Project-form probe, send `{"stored": true}` for a secret to reuse the Test
Project's saved one; the Service-form probe uses the saved value of every key you leave out.

## Testing them

The test kit sends `/.well-known/opsiforce/…` paths as the platform:

```ts
const answer = await kit.fetch('/.well-known/opsiforce/options/listBoards', {
  method: 'POST',
  body: JSON.stringify({ form: 'projectForm', values: {}, query: 'sprint' }),
});
assert.deepEqual(await answer.json(), [{ value: 'B1', label: 'Sprint 42' }]);

const saved = await kit.fetch('/.well-known/opsiforce/hooks/onProjectConfigurationSaved', {
  method: 'POST',
  body: JSON.stringify({ previous: null, current: { boards: [] } }),
});
assert.equal(saved.status, 204);
```

A Project-form call in the kit runs for the kit's caller, `pe_test`; `kit.service.state` shows what a
hook stored.
