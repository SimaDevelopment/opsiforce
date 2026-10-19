---
name: external-service-authoring
description: Building a Custom External Service on SDK 2 as a transparent proxy in front of an outside system — the order of work, Stop 1, service.json forms and Event types, Service routes and pass-through groups, upstream credentials, form handlers and hooks, webhooks and deliver(), unit and live tests, the Service skill, PUBLISH.md and the hand-over. Load it before designing, writing, testing, publishing or upgrading the service.
---

# Building a Custom External Service

A Custom External Service is one program in front of one outside system, the **upstream**. Every
Project of this Organization reaches it at its Service host, `https://<slug>.$EXTERNAL_SERVICES_HOST`,
with the upstream's own clients: its CLI, its SDK, a protocol client such as git, `curl`, App code. The
platform lets a request through only on **who** is calling and **which service** is addressed; it never
reads what was asked. Everything that looks at a request is yours: the service's **Service policy**.

So the service is a **transparent proxy with a policy**. It passes the upstream's own API through, and
for each request its code reads the caller's Project configuration (its **settings**) and either lets
it through, refuses it as *not allowed* naming the setting, or refuses it as *not supported* because no
route serves it. The settings come in **pass-through groups**: one group of routes per thing a setting
allows.

## What the SDK already does

Leave these to the SDK; your code adds only the policy:

- Refuses a request with no valid Caller identity (`401`, `unidentified`), a Project with no Project
  configuration (`403`, `not connected`) and a configuration missing a required field (`403`,
  `incomplete`), before any route runs.
- Refuses paths with `.` or `..` segments, `//`, `%2F` or `%5C` as *not supported*, and forwards every
  other path byte for byte, so the upstream receives exactly what your check approved. Through the
  Service host the edge has already resolved `.` and `..` segments, so `/a/<x>/../<y>` arrives as
  `/a/<y>` and your checks judge `<y>`: test the unsafe-path refusal in unit tests, not with live calls.
- Strips the caller's `Authorization`, `Proxy-Authorization`, `Cookie` and hop-by-hop headers, then
  adds the upstream credentials your `credentials` function returns.
- Streams bodies and answers untouched (uploads, `logs -f`, upgrades) unless your code reads them.
- Refuses a `handle` or form-handler answer that contains a secret of the Service configuration.
- Writes the Call log (every request, its outcome and reason) and the built-in Usage counters
  (`requests`, `not_allowed`, `failed`, `events`) to `/workspace/data/service-records.db`.
- Serves `GET /.well-known/opsiforce` from your route table, so calling agents read the routes, their
  summaries and settings live. The whole `/.well-known/opsiforce/` prefix is the SDK's: no route reaches
  it.

## The folder

The service is `/workspace/app`:

| Path | Holds |
| --- | --- |
| `service.json` | The Service manifest: header, Service form, Project form, Event types (`references/manifest.md`) |
| `service.types.ts` | Generated from `service.json` by `yarn types`; never edit it, always commit it |
| `service.ts` | `export default defineService<Manifest>({ manifest, routes, … })`: the groups' routes in order, counters, form handlers, hooks, webhook |
| `src/upstreams.ts` | The only file that knows the upstream's address and credentials |
| `src/groups/<group>.ts` | One pass-through group per file, exporting `routes` |
| `src/access.ts` | The helper every group's check calls to read the settings |
| `src/forms.ts`, `src/hooks.ts`, `src/inbound.ts` | Form handlers, save hooks and the webhook handler, only when the service has them |
| `test/groups/<group>.test.ts` | Each group through `testService(service, …).fetch` |
| `test/service.test.ts` | A request outside every group is *not supported* |
| `SKILL.md` | The Service skill every consuming Agent reads (`references/service-skill.md`) |
| `README.md` | For whoever maintains it next: upstream, credential and its permissions, groups, Events, Usage, not in this version |
| `PUBLISH.md` | The Publish note the reviewer reads first, rewritten before each Publish (`references/review-stops.md`) |
| `icon.svg` | Optional, at most 32 KB, no scripts, no event attributes, no outside links |
| `vendor/external-service-sdk-<version>.tgz` | The SDK this service runs, installed unplugged |

A group file past ~300 lines splits by the upstream's own areas (`groups/cards/` with an `index.ts`
exporting `routes`). Shared lookups go in `src/lookups.ts`.

## The order of work

Each step ends on its completion criterion; move on only when it holds. You wait for the person at
four points, marked **wait**, and work on your own everywhere else.

1. **Brief.** Learn what the upstream is and **where it runs** (its public service, or a self-hosted
   or regional instance), who will call the service (Agents, App code, both) and **with which tools**
   (`curl`, the upstream's CLI or SDK, a protocol client, App code), what they need to do, which
   credentials the upstream offers, whether it sends webhooks, and which targets you may write to while
   testing (a sandbox project, a test board). **Wait** for the answers to what you cannot find out
   yourself, asked together in one message. *Done when* you can name the upstream's API and version
   with its docs link, where it runs, every caller tool, every action the brief asks for, and the test
   targets (or that there are none).
2. **Explore the upstream, read-only.** Read its API docs and any API description it publishes
   (OpenAPI, discovery documents), its authentication and permission model, its own protections, and
   what each caller tool sends: the paths a CLI calls at login and for each action, the GraphQL
   operations, a protocol's own endpoints, the discovery calls. A CLI pointed at the Service host
   treats it as a self-hosted instance: note what it asks such a host at startup (a version or meta
   document), and when the upstream the service forwards to does not answer it, that request is a
   client shim for Stop 1. When the docs or the API live on the person's own instance, add only its
   address field to `service.json` (`format: url`, with `allowHttp: true` unless the person said the
   instance serves https, and a help line saying http is unencrypted), ask them to save it in this
   chat's Development configuration, and
   read it back from `GET $SERVICE_GATEWAY_URL/_builder` (`development.serviceConfiguration.values`,
   secrets masked). Keep what you learn in `/workspace/.cache/upstream/notes.md`, with the docs links,
   so a later change re-reads the notes instead of the docs. *Done when* the notes list, for every
   action in the brief, the requests each tool sends (method and path, startup calls included) and
   which of them change something upstream.
3. **Stop 1. Wait** for the person's yes to the whole proposal: `references/review-stops.md` has the
   exact contents. You may draft `service.json` and run `yarn check`; write no route, handler or test
   yet. *Done when* the person approved the whole proposal. Then ask them to create the agreed
   credential and type it into this chat's Development configuration, so the live tests can run when
   the code is ready.
4. **Code and unit tests, one group at a time.** `service.json` (`references/manifest.md`), then
   `src/upstreams.ts` and each `src/groups/<group>.ts` with its `test/groups/<group>.test.ts`
   (`references/routes.md`, `references/testing.md`), form handlers and hooks (`references/handlers.md`),
   the webhook (`references/inbound.md`). `references/patterns.md` has snippets for the common pieces.
   *Done when* `yarn check`, `yarn typecheck` and `yarn test` pass, every group has the tests
   `references/testing.md` requires, the code lets through exactly what Stop 1 approved, and it is
   committed.
5. **Service skill.** Write `SKILL.md` (`references/service-skill.md`) and `README.md`, create the Test
   Project if the lane shows none, save its settings for the first round, and deliver the skill
   (`POST $SERVICE_GATEWAY_URL/_builder/test-project/update`). *Done when* both are committed and the
   Test Project has the new skill.
6. **Live tests.** Call Development as the Test Project with its own Gateway Key, through the real
   clients, then **wait** while the person sends your consumer prompt in the Test Project's pane
   (`references/testing.md`). When the service delivers Events, ask in that same message for what only
   the person can do upstream: register Development's Webhook address on a test target, with the
   events to tick, and save the secret it shows in this chat's Development configuration
   (`references/inbound.md`). *Done when* every expectation has a result from one source, every Event
   type was delivered to the Test Project from the upstream or the person chose to skip it, and the test
   report is written for the last commit.
7. **Hand-over. Wait** for the person after writing `PUBLISH.md` and showing them the Service skill's
   full text (`references/review-stops.md`). *Done when* the hand-over checklist there holds.

When the person asks for a change later, start again at the step it touches: a new group, setting,
check rule, Event type or counter is Stop 1 again; a bug inside an approved check is step 4.

## The loop

```sh
yarn check        # external-service-cli check: service.json and the icon
yarn types        # external-service-cli types: regenerate service.types.ts
yarn typecheck    # tsc: routes, checks and handlers against the generated types
yarn test         # node:test on the test kit
```

Development already runs `yarn dev` (`external-service-cli dev`), which serves the folder on
`$APP_PORT`, rewrites `service.types.ts` and restarts on every change. When it does not come back, its
reason is in the platform's process logs (the `platform` skill's Process logs). Commit every change that
passes, `service.types.ts` and `yarn.lock` included: production installs and serves exactly what is
committed (`yarn install --immutable`, then `external-service-cli serve`).

`external-service-cli report --from <lines.json>` writes the test report (`references/testing.md`).

## Rules for every route

- **Groups match the settings.** One read group per kind of target (everything the upstream reads
  inside the allowed targets passes, so the clients work; lists are filtered), one group per kind of
  change, each off by default, and nothing else: no catch-all route outside a group.
- **Add a check only to enforce a setting or protect a secret or the upstream account**: filter a list,
  narrow a search, escape a search qualifier, look up an item's target before acting on it, require a
  sign-off line. Leave the upstream's answers, names, query parameters and limits as they are: a
  parameter no setting governs passes through, since clients send ones you did not list.
- **One Service configuration serves every Project.** In a route, use only the items of
  `ctx.serviceConfiguration` the caller's Project configuration references (the account it picked);
  `service.configuration()` is for code with no caller (`references/handlers.md`).
- **Secrets live only in the configurations.** Files, logs, `ctx.note` fields, tests, `README.md` and
  the chat carry placeholders. The person types a secret into a form, never into the chat.
- **Every refusal message says what was refused and what would allow it, or whom to ask**, in the
  caller's words, with names people know ("Closing a ticket needs Allow closing on queue Billing; this
  Project has Read"). The SDK adds the setting's label and its link (`references/routes.md` §Refusals).
- **A Service-form problem is the Organization admin's to fix**: a missing or refused credential, an
  address that does not answer. Refuse it with no Project setting, naming the field and "an
  Organization admin, on this service's page in Store → External Services". The same code runs in
  Development and in the copy callers use, so the message names neither.
- **Counters are display only.** Name them `snake_case`; a cap the service enforces is `ctx.state`.

## Where the truth is

- **The SDK this service runs** is plain files under `.yarn/unplugged/`: `README.md`,
  `WIRE-CONTRACT.md` (everything the platform relies on) and the `.d.ts` files of every
  function named here. Find them with `find .yarn/unplugged -path '*external-service-sdk*' -name WIRE-CONTRACT.md`.
  When this skill and those files disagree, the files win, and say so in your hand-over.
- **The newest SDK this image ships**, read-only: `/opt/opsiforce/external-service-sdk/latest/`.
- There is no reference service to copy. Build from the upstream's docs and `references/patterns.md`.

## Upgrading the SDK

A service runs the SDK in its `vendor/` file name until someone upgrades it, within major 2. Compare the
vendored `CHANGELOG.md` with `/opt/opsiforce/external-service-sdk/latest/CHANGELOG.md`, and **suggest**
an upgrade only when the newer version fixes a bug this service hits or adds something the person asked
for. Once they agree:

1. Copy `/opt/opsiforce/external-service-sdk/external-service-sdk-<new>.tgz` into `vendor/`, point the
   dependency in `package.json` at `file:./vendor/external-service-sdk-<new>.tgz`, remove the old
   tarball and run `yarn install`.
2. Run the loop, rerun the live lines the change touches and write a new test report.
3. Commit the tarball, `package.json`, `yarn.lock` and `service.types.ts` together. Callers keep the old
   version until a human publishes.
