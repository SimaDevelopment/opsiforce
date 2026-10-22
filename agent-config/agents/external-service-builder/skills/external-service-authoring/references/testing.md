# Testing a service

Three sources prove a service, and all three are required: **unit tests per group** (the policy, on
every change), **live calls as the Test Project** with the real clients (the credentials, the clients,
the route table), and **one consumer prompt** (the Service skill). Development's records file is the
evidence for the last two.

## Contents

- Unit tests per group
- The builder lane
- Live calls as the Test Project
- Reading Development's records
- The consumer prompt
- How a round runs
- The test report

## Unit tests per group

Each `test/groups/<group>.test.ts` drives the real service in memory through the test kit:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { testService } from '@opsiforce/external-service-sdk/testing';

import service from '../../service.ts';

const serviceConfiguration = { apiKey: 'test-key', apiToken: 'test-token' };
const withBoard = (access: string) => ({ boards: [{ id: 'i1', boardId: 'B1', access }] });

test('a card move passes with Change cards on its board', async () => {
  const kit = testService(service, {
    serviceConfiguration,
    projectConfiguration: withBoard('cards'),
    upstreams: { api: (request) => (request.method === 'GET' ? Response.json({ boardId: 'B1' }) : Response.json({ id: 'C1' })) },
  });

  const answer = await kit.fetch('/v1/cards/C1?list=L2', { method: 'PUT' });

  assert.equal(answer.status, 200);
});

test('a card move is refused with Read access, naming Boards', async () => {
  const kit = testService(service, {
    serviceConfiguration,
    projectConfiguration: withBoard('read'),
    upstreams: { api: () => Response.json({ boardId: 'B1' }) },
  });

  const answer = await kit.fetch('/v1/cards/C1?list=L2', { method: 'PUT' });

  assert.equal(answer.status, 403);
  assert.equal(answer.headers.get('opsiforce-outcome'), 'not allowed');
  assert.equal(answer.headers.get('opsiforce-setting'), 'boards');
});
```

`testService(service, options)` runs the same pipeline a pod runs, with the caller's identity made for
you:

- `serviceConfiguration`, `projectConfiguration` (absent = the Project is *not connected*),
  `projectConfigurations` (what `service.projectConfigurations()` answers), `caller` (overrides of the
  test caller, `pe_test` by default), `deliveryResults` (`{ <pe>: 'over-cap' | … }` for `deliver()`).
  Secrets are plain strings in the test and `Secret`s in your code. Fill every required field of both
  forms with placeholders, or the kit refuses *incomplete* as the platform would.
- `upstreams: { <name>: (request) => Response }` fakes each upstream by name. Your `credentials` never
  run in tests (the live calls prove them), and **a request that reaches an upstream with no fake
  answers `502` *failed***: a refused test passes no fake, or one that cannot answer, so a wrongly
  allowed request fails it.
- `kit.fetch(path, init)` answers like the Service host; `kit.service` is the `service` handle
  (`state`, `projectConfigurations()`, …); `kit.deliveries` records `deliver()` calls. Paths under
  `/.well-known/opsiforce/` go as the platform (form handlers, hooks, the webhook).

What every service's unit tests cover:

1. Per group, one request allowed and one refused for **each setting that governs it**, the refusal
   asserting `Opsiforce-Outcome` and `Opsiforce-Setting`.
2. Every filtered list (an item outside the settings is gone) and every narrowed request (assert what
   the fake received).
3. Every lookup that decides (the item looked up to another target is refused).
4. One request outside every group: *not supported* (`test/service.test.ts` has it), and each refuse row.
5. Each form handler, hook and Event type the service has (`references/handlers.md`,
   `references/inbound.md`).

Assert what a caller sees: status, the two headers, what the fake received. Leave the upstream's answer
shapes to the upstream.

## The builder lane

Your pod's own key opens this chat's tooling at `$SERVICE_GATEWAY_URL/_builder`:

```sh
LANE="$SERVICE_GATEWAY_URL/_builder"
AUTH="Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
curl -s -H "$AUTH" "$LANE" | jq                                          # the service, Development, the Test Project
curl -s -H "$AUTH" -H 'content-type: application/json' -d '{}' -X POST "$LANE/test-project"
curl -s -H "$AUTH" "$LANE/test-project/configuration" | jq               # its saved settings (secrets masked), missing fields
curl -s -H "$AUTH" -H 'content-type: application/json' -X PUT "$LANE/test-project/configuration" \
  -d '{"values":{"boards":[{"boardId":"B9","access":"cards"}]}}'
curl -s -H "$AUTH" "$LANE/test-project/events?limit=50" | jq             # Events stored for the Test Project
curl -s -H "$AUTH" -X POST "$LANE/test-project/update"                    # deliver its Service skill again
curl -s -H "$AUTH" -X POST "$LANE/test-project/reset"                     # a clean round
```

- `GET` answers `service` (`id`, `slug`, `name`, `published`, `disabled`, `serviceHost`), `development`
  (`webhookUrl`, `servable` and its `problem`, `serviceConfiguration.saved`, its `values` with secrets
  masked as `{ "stored": true }`, and `missing`) and
  `testProject` (`id`, `projectEnvironmentId`, `status`, `gatewayKey`, …, or `null`).
- **Create** answers `201` with the Test Project, or `409 test-project-exists`. It runs App Builder
  unless the brief names another Agent (`{"agentId": "<id>"}`), and opens beside this chat, where the
  person can watch it.
- **Configuration** `PUT {values}` saves the Test Project's settings against Development's Project form,
  as the person would; a generated secret comes back once in `revealed`. Saving runs your
  `onProjectConfigurationSaved`.
- **Update** delivers Development's `SKILL.md` to the Test Project; run it after every change to it.
- **Reset** wipes the Test Project's workspace (and its Events), runs your hooks with `current: null`
  then again with `previous: null`, and deletes Development's `ctx.state`. Its settings and
  Development's records file stay.
- The probes for form handlers are in `references/handlers.md`.
- `401` means the key is missing; `403 not-a-builder-chat` that this pod is not the builder chat; `423`
  that the Test Project is disabled. Then every live line is not checked, with that reason.

## Live calls as the Test Project

The Test Project's own Gateway Key, sent to the Service host, reaches **Development** (your running
`yarn dev`) as that Project, with Development's Service configuration and the Test Project's settings,
exactly as a consumer's call reaches the published service:

```sh
HOST=$(curl -s -H "$AUTH" "$LANE" | jq -r .service.serviceHost)
KEY=$(curl -s -H "$AUTH" "$LANE" | jq -r .testProject.gatewayKey)
curl -s -H "Authorization: Bearer $KEY" "$HOST/.well-known/opsiforce" | jq
curl -si -H "Authorization: Bearer $KEY" "$HOST/v1/boards/B9/lists"
GIT_TERMINAL_PROMPT=0 git -c http.extraHeader="Authorization: Bearer $KEY" ls-remote "$HOST/<a repository the brief names>"   # a git upstream
```

- Keep `KEY` in a shell variable: never in a file, a URL, the chat or the report.
- Use the clients the brief names, set up exactly as the Service skill tells consumers to (a CLI that
  targets an enterprise host by environment variable, git's `http.extraHeader`, an SDK's base URL and
  header), with every prompt switched off. Install a client the pod lacks. A client that works here
  with the Service skill's setup is the proof the skill is right.
- **Development's Service configuration** holds the upstream credential, and the person fills it in
  this chat's Development configuration. Until `development.serviceConfiguration.missing` is empty,
  every request is refused *incomplete* and every live line is not checked.
- **Reads** may go to whatever that credential reaches. **Writes go only to targets the brief names**:
  put only those in the Test Project's settings, so the service refuses every other target. Delete only
  what the same round created. With no named target, write lines are not checked, with that reason.
- Prove each refusal live by saving settings in turn: allowed with one setting, then the same request
  refused after `PUT` of a narrower one, and the refusal printed by the client with its setting and link.

## Reading Development's records

Development is this pod, so its Call log and Usage are in your own workspace. Rows land within about
a second:

```sh
sqlite3 -readonly /workspace/data/service-records.db \
  "select request_id, time, method, path, route, outcome, status, reason from calls order by id desc limit 20"
sqlite3 -readonly /workspace/data/service-records.db \
  "select month, project_id, name, label, value from usage order by month desc, name"
```

Always `-readonly`: the SDK is the file's one writer. `outcome` is `proxied`, `handled`, `not supported`,
`not allowed` or `failed`, and `reason` is the message the service page shows. `route` is the matched
route's summary, a handler's `<kind>.<name>` or `webhook`; `notes` holds your `ctx.note` fields. The page shows the
same rows on the service's Calls tab (Development switch).

## The consumer prompt

At least one: the Test Project's Agent asked, in a user's words, to do a real task with the service,
so that what it learns from the Service skill and `/.well-known/opsiforce` is what is tested. Write the
prompt without naming a path, route or setting key ("Using the Boards service, move 'Fix login' to
Doing on the Sprint 42 board, then archive the roadmap card about SSO"), ask the person to send it
word for word in the Test Project's pane, then judge it from the Test Project's rows in Development's
Call log. An Agent that had to ask what an id means, retried a *not allowed*, or worked around a
refusal points at a gap in the Service skill: fix the skill, Update, and run it again.

## How a round runs

- Write the expectations first, one line per thing that must be true, before any call.
- Decide each from one source: a unit test, a live call's Call log row (its `request_id`), a stored
  Event, or a conversation's rows. The consumer Agent's own words are never evidence.
- Fix what failed and run the round again. Stop after two rounds that turn no failure into a pass, and
  report what still fails.

## The test report

The Publish review reads `/workspace/.cache/service-test-report.json`. Write it with the CLI:

1. Commit the service: the report records the commit, and uncommitted changes show as "Changed since
   the test".
2. Write the lines to a file outside `/workspace/app`, such as `/workspace/.cache/service-test-lines.json`:

   ```json
   { "lines": [
     { "expectation": "a card move on Sprint 42 passes with Change cards", "result": "pass", "source": "live-call", "callIds": ["<request_id>"] },
     { "expectation": "a card move on Roadmap is refused naming Boards", "result": "pass", "source": "unit-test", "callIds": [] },
     { "expectation": "card.moved reaches the Test Project", "result": "not-checked", "source": "event", "callIds": [], "reason": "the brief names no board the upstream can post from" }
   ] }
   ```

3. `yarn external-service-cli report --from /workspace/.cache/service-test-lines.json` stamps the commit
   and manifest hash and prints `wrote <path>: N pass, N fail, N not checked at <commit>`; a malformed
   report is refused with each problem's path, and nothing is written.

Each line is `{expectation, result, source, callIds, reason?}`: `result` is `pass`, `fail` or
`not-checked` (with a `reason`); `source` is `unit-test`, `live-call`, `event` or `conversation`, and a
`pass` or `fail` from `live-call` or `conversation` names at least one `callIds` entry, a `request_id`
from Development's Call log. At most 500 lines, 100 ids a line, 1000 characters a text. The review warns
"Never called the real upstream" until a live line cites a `proxied` request. Write a `fail` as a
`fail`: the review warns and never blocks, and the person publishing decides.
