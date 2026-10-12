---
kind: explanation
terms: [External Service Builder, Custom External Service, Default environment (External Service)]
adrs: [0081, 0083, 0086]
---

# External Service Builder

> How does an Organization write, test, publish and retire its own External Service, and which of its environments do callers reach?

## How it works

### The builder chat

- With `can_manage_tenant_external_services`, Store, External Services, **New External Service** takes a name and a slug (2 to 31 lowercase letters, digits and hyphens starting with a letter; never a built-in's name, another of the Organization's services or a reserved name) through `POST /api/external-services/services`. It registers the [Custom External Service](../../GLOSSARY.md) and its builder Project (kind `external_service_builder_chat`) and opens the chat at `/store/external-services/<id>/builder`; the slug can change (`PATCH …/services/<id>`) until the first Publish, and stored secrets stay readable because they are sealed under the service's id.
- Only holders of that permission open or chat in a builder Project and its Test Project, in every environment, because the pod shares a container with the service's secrets ([ADR-0078](../adr/0078-an-external-service-receives-its-secrets-with-each-call-from-the-gate.md), [Permissions](../organization/permissions.md)).
- The chat runs the [External Service Builder](../../GLOSSARY.md), the Built-in Agent `external-service-builder`: shared skills `platform` and `sqlite`, its own `external-service-authoring` skill, no Public API and no route to Publish. Its template is an empty, valid service in `app/` with `startup.sh` running `external-service-cli dev` in Development and `yarn install --immutable` + `serve` in Production ([Agent](../agent-system/agent.md)).
- The service carries its own SDK: `app/package.json` names `file:./vendor/external-service-sdk-<version>.tgz`, installed under Yarn Plug'n'Play with the SDK unplugged, so it runs the version it was published with until someone asks the builder to upgrade it ([ADR-0081](../adr/0081-a-custom-external-service-carries-its-own-copy-of-the-sdk-and-upgrades-it-only-when-asked.md)). The image keeps the newest SDK unpacked at `/opt/opsiforce/external-service-sdk/latest/` and the built-ins read-only at `/opt/agents/external-service-builder/reference/<name>/`. The version the page calls newest is the SDK `package.json` the backend was built from, the same file the agent image packs; CI keeps the two in step by refusing an SDK source change without a new SDK version and a new agent image version.

### The test lane

- The chat's [Test Project](../../GLOSSARY.md) runs a consumer Agent whose calls the [Gate](gate.md) sends to the service's Development (the builder Project's own ProjectEnvironment, draft or published), with Development's manifest and its own Service configuration (sealed with `+development`, empty until an Organization admin saves it or copies the callers' one through `…/services/<id>/development[/configuration]` and `…/development/configuration/copy-from-production`; a save, Rotate or copy runs Development's `onServiceConfigurationSaved`, with Retry at `…/development/configuration/hook/retry`). Its webhook URL is `…/webhooks/<id>/development`, whose Events reach only that Test Project, and its `ctx.state` is the file in Development's own data folder ([ADR-0086](../adr/0086-the-external-service-builder-tests-a-service-through-a-consumer-agent-against-developments-own-service-configuration.md)).
- The builder's pod drives the lane with its own `service` key under `/api/external-services/agent/_builder`: `GET` (slug, name, Development's webhook URL and configuration state, the Test Project), `POST test-project` (once), `GET/PUT test-project/configuration` (a save answers `revealed` once, like any save), `GET test-project/events`, `POST test-project/update` (delivers the Service skill again from Development) and `POST test-project/reset` (the Test Project Reset, which also runs `onProjectConfigurationSaved` with `current: null` for Development, deregisters Development's own registrations through `onServiceConfigurationSaved` with `current: null`, wipes Development's state and registers them again with `previous: null`), plus `probe`, `probe/openapi.json`, `probe/calls`, `POST probe/<operation>` and `POST probe/{options|info|buttons}/<name>` (the Test Project's Project form calls, against Development, so the builder can turn the names a brief gives into the ids a Project configuration needs), which answer exactly what the Gate answers the Test Project.
- Conversation prompts go through the person, in the Test Project's pane beside the chat. `external-service-cli report` writes `/workspace/.cache/service-test-report.json` (commit, manifest hash and one line per expectation with its result, source and Call ids) for the Publish dialog.

### Publish

- A human publishes from the service page, never the builder; the Project Publish route answers `409 publish-from-service-page` for a builder Project. The Publish dialog has the Custom Agent's layout: one row per environment (badge, name, "Published · <commit>" or "Not published yet"), a "What <Environment> will receive" card holding the review, a **Callers reach** select of the published environments, and **Publish to <Environment>**. `GET …/services/<id>/publish?environmentId=` is the dialog's review: the `check` report of Development's `app/`, with each Operation and Event marked added, changed (kind, input schema, bounds, title or description) or unchanged against the version published in the chosen environment and the ones Development drops listed as removed (with the Project configurations that switch them on, when the impact is shown), the impact on every Project configuration read tolerantly against the new manifest (shown when the target is or becomes the Default environment), the test report with what changed since its commit (it warns and never blocks), and the Service form fields the callers' configuration lacks (all of them on the first Publish), each with "Copy from Development".
- `POST …/publish {environmentId, values, copyFromDevelopment}` refuses a failing `check` (`409 check-failed`) or an unmet required field (`400 invalid-configuration`), saves the listed fields beside the stored values the live version still reads under a renamed field's old key, defers `onServiceConfigurationSaved` to the new version and queues the Project Publish without Environment Variables or Schedules; `GET …/publish/job` follows it, and `GET …/environments` lists the published version in each environment.
- The first Publish sets the [Default environment (External Service)](../../GLOSSARY.md), never Development; `GET/PUT …/default-environment` switches it to another environment holding a finished Publish (`409 not-published`), after the same review, which the dialog shows in place when **Callers reach** is changed. Whenever a version becomes the Default environment's, the platform fills newly generated fields, runs the deferred hook and delivers the Service skill again ([Publish](../projects/publish.md)).

### The Default environment

- Every caller but the Test Project reaches the Default environment: Operations, form calls, hooks and inbound. Its handlers keep `ctx.state` in the Default environment's own file. Its manifest, Service skill text, icon and SDK version are read from its `app/` on the shared volume, cached by modification time, so a Publish is picked up without waking the pod ([ADR-0083](../adr/0083-a-custom-external-services-default-environment-never-sleeps-its-state-lives-in-that-environments-workspace-and-is-copied-on-a-switch-and-its-webhook-url-belongs-to-the-service.md)). A file there (or under a linked directory) that resolves outside `app/`, or isn't a regular file, counts as missing: a `service.json` or icon like that makes the service unservable, and a `SKILL.md` or `package.json` like that is ignored; the Publish review and the test report read the same way.
- The Default environment never idle-sleeps; a down pod is woken and the call held up to 60 s. The webhook URL belongs to the service. A switch holds new calls with `503 service-reloading` (webhooks wait up to 5 s instead, and a call routed to the old Default just before the switch is refused rather than run there), lets the calls in flight finish on the old pod (up to 30 s, else `409 service-busy`), copies the old Default's `ctx.state` file over the new one's and only then moves callers and inbound, so callers, state and inbound move at once.

### The service page

- The page shows a **Draft** badge until the first Publish and "<Environment> · default" after, an SDK badge ("SDK 1.0.0", "· 1.3.0 available" when this release ships a newer SDK of the same major, "needs upgrade" once the platform no longer accepts it), **Edit in Builder**, **Publish** and an actions menu with Copy webhook URL, Download service.json, Duplicate, Export, Disable or Enable and Delete ([Settings](../organization/settings.md)); the list offers **Import service** beside New External Service ([Service copies](service-copies.md)).
- The Overview tab of a custom service has the Custom Agent page's **Environments** list beside it: Development ("Where you edit") and every other environment, each "Same as Development", "Development differs" (Development's `app/` changed since the commit published there) or "Not published yet", with **Default** on the one callers reach. The selected row lives in the URL (`?env=`) and starts on the Default environment (Development before the first Publish); Operations and Events show that environment's manifest, read from its `app/` by `GET …/services/<id>/manifests`. Away from the Default environment each item is marked added or changed against the Default's manifest, and an item it drops is listed struck through as removed, with "used by N Project configurations" when Project configurations switch it on. The Configuration, Calls and API tabs, and a built-in service's page, show only what callers reach.
- Disable (`POST …/services/<id>/disable`) disables the builder Project: its pods stop, calls and its webhook answer `503 service-disabled`, Project forms, the chat bar and Agents stop seeing it (its Service skill is delivered again to every environment that had it), and everything is kept until Enable, which delivers it again the same way. The Project routes' Disable and Enable of the builder Project do exactly the same; their Delete of the builder Project or of one of its environments answers `409 manage-from-service-page`, and the Project menu offers neither. Delete lists the consuming ProjectEnvironments (`GET …/consumers`), needs the slug typed (`DELETE …/services/<id>?confirmSlug=<slug>`, else `400 slug-mismatch`), runs `onProjectConfigurationSaved` with `current: null` for each consumer on the version it reaches (Development for the Test Project, drafts included, whose sleeping pod is woken first within the 60 s start hold; none while the service is disabled; 10 s each once the pod serves, failures logged) and deletes the builder Project with every configuration, state and not-wired mark, and its Service skill with every Agent's pin of it; callers then get `404 unknown-service` and the slug is free.

## Edge cases

- When the builder chat has no Development Service configuration, its live test lines are reported not checked.
- When the vendored SDK is of another major than the platform accepts, the service's calls answer `502 service-failed` and the page says "needs upgrade".
- When a Built-in External Service later takes a custom service's slug, the built-in stays hidden in that Organization and the service page says so.
- When a Delete's consumer hook fails, the Delete goes on and the failure is logged.

## Code

- `backend/src/external-services/custom/` — creating a service and its builder chat, the `_builder` lane, Disable, Enable and Delete.
- `backend/src/external-services/publishing/` — the Publish review, the `check`, impact and test reports, the manifest of each environment and the diff between two manifests, the SDK status, and the Default environment with the first-Publish hook.
- `backend/src/external-services/registry/` — reading a published service from its files.
- `backend/src/external-services/test-lane/` — the Test Project's starting Project configuration, its Update and its Reset.
- `backend/src/external-services/external-services-project-lifecycle.ts` — what External Services does when a Project is created, disabled, enabled, reset or removed.
- `agent-config/agents/external-service-builder/` — the agent, its authoring skill and the service template.
- `frontend/src/pages/store/external-service-page.tsx` — the service page, its header, tabs and dialogs.

## Related

- [Service manifest](service-manifest.md) — the folder the builder writes.
- [Gate](gate.md) — how calls reach Development or the Default environment.
- [Test Project](../agent-system/test-project.md) — the Test Project mechanics the lane reuses.
- [Publish](../projects/publish.md) — the Project Publish the service page queues.
- [Settings](../organization/settings.md) — the Store's External Services tab.
- [Service copies](service-copies.md) — Duplicate, Export and Import of a Custom External Service.
