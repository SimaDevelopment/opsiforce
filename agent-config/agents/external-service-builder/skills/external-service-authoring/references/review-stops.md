# Review stops, testing and the test report

A Custom External Service passes two human reviews. **Stop 1** is yours to hold: the API design,
approved before any handler exists. **Stop 2** is the Publish dialog on the service's page, which a
human opens; you prepare what it shows.

## Contents

- Stop 1: the API design
- Testing
- The test report
- Stop 2: handing over for Publish

## Stop 1: the API design

Before you write or change any handler, show the design and wait for an explicit approval. You may
draft `service.json` and run `yarn check` to make sure the design is valid; write no handler and no
handler test until the person approves.

Show it as tables in the chat, not as raw JSON:

1. **Service form**: each field with its key, type, whether it is required, and what it holds. Mark every
   `secret`, every `generate`d value, and every list (one item per account, number, workspace).
2. **Project form**: each field, and what it limits for a Project (which account, which boards).
3. **Each Operation**, one row each:

   | Operation | Kind | What it does | Input (required in bold) | Bounds on it | Checked in code |
   | --- | --- | --- | --- | --- | --- |
   | `create_task` | write | Creates a task on a list | **`boardId`**, **`listId`**, **`name`**, `labels` | `boardId` → `board` (Project's `boardIds`, or all when "All boards") | `listId` belongs to `boardId` |

   Say plainly when a write or destructive Operation has no bound ("can create a task anywhere the stored
   token reaches") and ask whether that is acceptable.
4. **Events**, if the service receives webhooks: each type, what it carries, its bound property, and how
   the webhook gets registered (the admin pastes `{{webhookUrl}}`, or a save hook registers it).
5. **Not in this version**: the next capabilities of this system the brief did not ask for, one line
   each with its kind, so the person can pull any in now or ask for it later in one sentence; and
   anything the brief asked for that the SDK cannot do (an OAuth flow, a file field, a long-lived
   connection).
6. For a service that is already published: what the change does to stored configurations (renamed
   fields carried by `was`, newly required fields, new Operations arriving off).

End with one question: approve the design, or say what to change. Change it as often as asked and show
the new tables each time. After approval, a change to any Operation's kind, input or bounds, or to the
Events, goes back to the person before you write it; a fix inside a handler does not.

## Testing

Two lanes, both required.

**Unit tests** (`yarn test`, the SDK test kit, `references/handlers.md` §Unit tests) run on every
change, with placeholder credentials and `upstream.reply`.

**Live tests** run in this chat's **Test Project**: a throwaway Project beside this chat whose
consumer Agent calls the service through the Gate exactly as users will. Its calls alone reach this
service's Development (your running `yarn dev`) with Development's own Service configuration; every
other caller reaches the published service. Its Events come only from Development's own webhook URL.

You drive it with this chat's own key through `$EXTERNAL_SERVICES_URL/_builder` (call it `$LANE`):

```sh
LANE="$EXTERNAL_SERVICES_URL/_builder"
AUTH="Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
curl -s -H "$AUTH" "$LANE"                                       # this service: slug, name, Development, Test Project
curl -s -H "$AUTH" -H 'content-type: application/json' -d '{}' -X POST "$LANE/test-project"   # create it once
curl -s -H "$AUTH" "$LANE/test-project/configuration"            # its Project configuration (masked)
curl -s -H "$AUTH" -H 'content-type: application/json' -X PUT "$LANE/test-project/configuration" \
  -d '{"values":{"boardIds":["B9"],"operations":{"create_task":true},"receive":{"card.created":true}}}'
curl -s -H "$AUTH" -H 'content-type: application/json' -d '{"boardId":"B9"}' "$LANE/probe/list_tasks"
curl -s -H "$AUTH" "$LANE/probe"                                 # describe, as the Test Project sees it
curl -s -H "$AUTH" "$LANE/probe/openapi.json"
curl -s -H "$AUTH" "$LANE/probe/calls?limit=50"                  # the Test Project's Call log rows
curl -s -H "$AUTH" -H 'content-type: application/json' -d '{"query":"sprint","values":{}}' "$LANE/probe/options/listBoards"   # your own picker, as the Test Project
curl -s -H "$AUTH" "$LANE/test-project/events?limit=50"          # the Test Project's `events` rows
curl -s -H "$AUTH" -X POST "$LANE/test-project/update"           # deliver its Service skill again
curl -s -H "$AUTH" -X POST "$LANE/test-project/reset"            # a clean round (below)
```

- **Read your slug from `$LANE`, every time you need it.** It can change until the first Publish; never
  write it into a file.
- **Create** answers `201` with the Test Project, or `409 test-project-exists` with its `testProjectId`.
  It runs App Builder unless the brief names another Agent: send `{"agentId": "<id>"}`. It opens
  beside this chat for the person, who can watch it.
- **`probe/*` is the Gate answering the Test Project**: the same checks, refusals, Call rows and
  describe. A probe is how you check an Operation, a Gate refusal or an indirect id live.
- **Conversation prompts** go to the Test Project's Agent through its pane beside this chat: write the
  prompt in a user's words, never naming an Operation, ask the person to send it there word for word,
  then judge it from `probe/calls` and `test-project/events`.
- **Update** delivers the Service skill again from Development's `SKILL.md`; describe and
  `openapi.json` are live already. Run it after changing `SKILL.md`.
- **Reset** wipes the Test Project and lays it again: its Events are gone, Development's webhooks are
  deregistered through `onProjectConfigurationSaved` with `current: null`, and Development's `ctx.state`
  file is deleted. Its Project configuration stays; save it again to register webhooks for the next round.
- Live upstream calls need Development's Service configuration, which a human fills in this chat's
  **Development configuration** (empty, or "Copy from Production"). `$LANE` says whether it is saved and
  what it misses; until it is filled, every live line is `not-checked`.
- **Reads** may run against whatever that configuration reaches. **Writes go only to targets the brief
  names**: put only those ids in the Test Project's Project configuration (when the brief names them,
  find their ids with your own picker through `probe/options/<name>`), so the Gate refuses
  everything else. A destructive call acts only on what the same round created. With no named target,
  write and destructive lines are `not-checked`, with that reason.
- Development's webhook URL is `development.webhookUrl` in `$LANE` (`/webhooks/<id>/development`). Post
  recorded payloads there, signed with Development's own secret; the published URL never reaches the
  Test Project.
- When `$LANE` answers `403` or the Test Project is disabled (`423` on Reset), say so; every live line
  is then `not-checked` with that reason.

### What every service's tests cover

1. **Every Operation called once** with valid input: a unit test, then a live call.
2. **Gate refusals**: `operation-off`, `invalid-input` and `out-of-bounds` (and `input-too-large` where
   a limit matters) in unit tests, plus **one live**, which proves the route.
3. **Refusals only your code makes, live**: each indirect id (an object reached by id whose parent is
   outside the bounds) and each filtered output (a search that must not return what the Project did not
   choose).
4. **Every Event type delivered once** to Development's URL (`references/inbound.md` §Testing inbound).
5. **At least one conversation prompt**: the Test Project's Agent asked in a user's words to do a real
   task with the service, so its Service skill, describe and `openapi.json` are what it learns from.

### How a round runs

- Write the expectations first: one line per thing that must be true, before any call.
- Decide each expectation from one source: a unit test, a live call's Call log row (`callId`), an
  `events` row, or a conversation's Call log rows. The consumer's own prose is never evidence.
- Fix what failed and run the round again. Stop after two rounds that turn no failure into a pass, and
  report what still fails.

## The test report

The Publish dialog reads `/workspace/.cache/service-test-report.json`. Write it with the CLI, never by
hand:

1. Commit the service. The report records the commit; uncommitted changes show as "Changed since the
   test".
2. Write the lines to a file outside `/workspace/app`, such as `/workspace/.cache/service-test-lines.json`:

   ```json
   { "lines": [
     { "expectation": "create_task creates a task on board B9", "result": "pass", "source": "live-call", "callIds": ["c_8f2…"] },
     { "expectation": "get_task refuses a task on a board outside the bounds", "result": "pass", "source": "unit-test", "callIds": [] },
     { "expectation": "delete_task deletes a task", "result": "not-checked", "source": "live-call", "callIds": [], "reason": "the brief names no board to write to" }
   ] }
   ```

3. `yarn external-service-cli report --from /workspace/.cache/service-test-lines.json` stamps the commit
   and the manifest hash, writes the report and prints `wrote <path>: N pass, N fail, N not checked at
   <commit>`. A malformed report is refused with each problem's path, and nothing is written.

Each line is `{expectation, result, source, callIds, reason?}`:

- `result` ∈ `pass`, `fail`, `not-checked`; a `not-checked` line has a `reason`.
- `source` ∈ `unit-test`, `live-call`, `event`, `conversation`; a `pass` or `fail` from `live-call` or
  `conversation` names at least one `callId`.
- At most 500 lines, 100 `callIds` per line, 1000 characters per text.

Write a `fail` as a `fail`. The dialog warns on failures and never blocks; the person publishing
decides.

## Stop 2: handing over for Publish

The Publish dialog shows the `check` report (kinds, bound and unbound inputs, warnings), the impact on
existing Project configurations, your test report, and every newly required Service form field. Before
you say the service is ready:

- `yarn check` has no error, and every warning is one the person approved in Stop 1;
- `yarn typecheck` and `yarn test` pass, and everything is committed, `yarn.lock` included;
- the conversation prompt ran: you wrote it word for word, the person sent it in the Test Project's
  pane, and you judged it from `probe/calls`. When it has not run yet, your hand-over is that prompt and
  the request to send it; say "ready" after you have judged it, or once the person has said to skip it;
- the test report is written for the last commit.

Then say what the service does, what was tested and by which source, what was not and why, and that a
human with the permission publishes it from the service's page in Store → External Services.
