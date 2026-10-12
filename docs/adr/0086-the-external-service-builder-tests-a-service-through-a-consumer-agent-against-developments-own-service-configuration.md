# The External Service Builder tests a service through a consumer Agent, against Development's own Service configuration

A Custom External Service exists to be used by other agents and Apps, through docs its author wrote (the Service skill, describe, `openapi.json`) and a Gate its author does not control. The External Service Builder wrote all of that, so its own calls prove little ([ADR-0063](0063-the-builder-tests-a-child-agent-by-conversing-with-it-in-one-throwaway-project.md)'s argument). Development runs in the builder's own pod, and the Organization's one Service configuration is what every published environment reads.

**The External Service Builder tests a service in its chat's Test Project, run by a consumer Agent whose calls the Gate sends to the service's Development. Development reads its own Service configuration and receives webhooks at its own URL, and both reach only that Test Project. Live upstream calls are opt-in, and writes are confined by the Gate's own bounds to targets the author named. The Publish dialog shows the test report and fills any Service configuration field the new version needs before callers see it.**

## Testing

- **The Test Project.** One per builder chat, created and refreshed by the ADR-0063 mechanics, on App Builder or a Custom Agent the brief names. The builder has no Public API, so it does both through its own routes under the Gate's mount (`agent/_builder`), by its Development's service key, and writes the Test Project's Project configuration there; the same routes answer the service's slug live, which can change until the first Publish. The Gate routes its calls to Development; every other caller reaches the Default environment (External Service). Its Project configuration for the service is created with it, which gives it the Service skill whatever its Agent carries ([ADR-0082](0082-an-external-services-skill-is-a-skill-marked-by-its-service-given-per-agent-or-per-project-and-reads-its-operations-live.md)), and its Service skill is Development's.
- **Update and Reset.** Update (Test Project) delivers the Service skill again from Development; describe, `openapi.json` and the Service configuration are live already. Reset (Test Project) also empties its `events`, deregisters Development's webhooks through the save hook and deletes Development's `ctx.state` file.
- **Probes and conversation.** The builder probes the Gate as the Test Project through `agent/_builder/probe/*`, which runs the Gate's own checks and logs ordinary Calls for the Test Project, and converses with the consumer in prompts written like a user's, which the person sends in the Test Project's pane beside the chat. Evidence is the Gate's call log rows by `callId`, unit test output and `events` rows, never the consumer's prose.
- **What every test covers.** Each Operation called once with valid input. One Gate refusal live, proving the route; the rest of the Gate's refusals in unit tests. Every refusal only service code makes, checked live: indirect ids (Trello `get_card` on another board's card) and output filtering (GitHub search outside the allowed repos). Every Event type delivered once. At least one conversation prompt. Otherwise ADR-0063's loop: expectations written first, prompts word for word, one source per verdict line, stop after two rounds that turn no failure into a pass.
- **The SDK test kit.** `@opsiforce/external-service-sdk/testing` on `node:test`: `testService(manifest, handlers, configurations)` gives `call`, `options`, `inbound` and a fake `ctx` (memory `state`, captured `log`, `Secret`, `file()`, `signal`). `call` runs the Gate's operations, input and bounds checks through the same bounds checker the Gate imports from the SDK. `upstream` intercepts `fetch`; non-HTTP clients get a test database or are checked live.

## Development's own Service configuration and webhooks

- **Two Service configurations for a Custom External Service.** One is read by every published environment, the other only by Development. It starts empty or from an explicit "Copy from Production", secrets sealed again. Publish never copies it. Built-in External Services have one; they have no Development.
- **Development's webhook URL**, `/api/external-services/webhooks/<external_service_id>/development`, is `ctx.webhookUrl` in every Development call. Its Events are matched only against the builder chat's Test Project, through the same matching, `events` table and doorbell. The builder replays fixtures by posting to it. Before the first Publish it is the only URL that receives anything.

## Live calls

- Upstream calls happen only once someone fills Development's Service configuration. Without it, every live line is *not checked*.
- Reads run against whatever it points at. Writes reach only targets the brief names: the Test Project's Project configuration holds only those (`boardIds: ["B9"]`), so the Gate refuses everything else with `403 out-of-bounds`. A destructive call acts only on what the same round created. No named target: write and destructive lines are *not checked*, with that reason.

## Publish

- `yarn external-service-cli report` writes `/workspace/.cache/service-test-report.json` (commit, manifest hash, lines with result, source and `callId`s), refusing a malformed one. The Publish dialog reads it from Development's files and shows it beside the `check` report and the [ADR-0079](0079-a-changed-service-manifest-reads-old-configurations-tolerantly-and-never-turns-on-new-operations.md) impact report: counts, "Changed since the test: `handlers.ts`", "Not tested", "Never called the real upstream". It warns and never blocks.
- The dialog lists every field the new Service form requires that the Service configuration callers use lacks, with inputs and a per-field "Copy from Development" off by default. Publish stays disabled until that configuration validates, and the values are saved with the Publish. The first Publish is the same dialog with every field listed.

## Considered options

- **The builder calling its own service from its own pod, with no Test Project.** Rejected: the service becomes its own consumer, and nobody reads its delivered docs with a context that did not write them.
- **One Service configuration shared by Development and the published environments.** Rejected: saving through Development's form rewrites a `was`-renamed key, the published code finds its field missing and every consumer gets `409 configuration-incomplete` before anything is published; a Rotate while testing rotates what callers use.
- **A Service configuration per environment, carried forward by Publish.** Rejected: it carries a test login's credentials over the ones callers use.
- **Vitest and MSW in the template.** Rejected: two more dependencies in every vendored service, and the Gate's checks re-implemented as mocks.
- **Only live tests, no kit.** Rejected: slow, spends upstream calls, and cannot reach paths such as Trello's `429`.
- **Fakes only, never the real upstream.** Rejected as the only option: fakes encode what the builder believes about the API. Trello's `HEAD` check of a webhook callback URL, its `key`/`token` query parameters and `idList` on `POST /1/cards` would surface first in Production.
- **Replaying webhooks only, through a dry-run endpoint that stores nothing.** Rejected: the save hook's upstream registration and the doorbell into an App would go untested until Production.
- **A probe matrix generated from the manifest.** Rejected: it re-tests the Gate, which has its own tests, and says nothing about indirect ids, output filtering or Events.
- **Asking the human before every live write.** Rejected: it trains the human to approve unread.
- **Blocking Publish on a missing or stale report.** Rejected: a one-line fix would cost a full round, and the person publishing holds the decision.
- **Publishing first and filling new fields afterwards.** Rejected: the service stops being Available and every consumer gets `503 service-not-configured` until someone does.
- **Filling new fields ahead of Publish in the configuration callers use.** Rejected: a second place to do the dialog's job that nobody knows to visit.

## Consequences

- A builder chat with Development's Service configuration filled holds working upstream secrets in the builder's pod, which is why building requires `can_manage_tenant_external_services` ([ADR-0078](0078-an-external-service-receives-its-secrets-with-each-call-from-the-gate.md)).
- A provider that allows one webhook URL per app (a GitHub App) needs a second app for Development.
- Test calls are ordinary call log rows whose service environment is Development.
- A non-default published environment, reached only by test calls, reads the Service configuration callers use.
