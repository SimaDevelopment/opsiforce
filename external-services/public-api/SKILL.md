---
name: service-public-api
description: How to act on this Organization's Agents, Skills and Projects through the Opsiforce Public API (`public-api`), as the human who created this Project.
---

# Opsiforce Public API

`public-api` is the platform's own API: **Opsiforce Public API v1**, documented at `/api/v1/docs` on
the main host. Call its real paths on its Service host with this Project's key in a header:

```bash
curl -s "https://public-api.$EXTERNAL_SERVICES_HOST/api/v1/me" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

## How it differs from calling the API as a person

- Every call acts as the human who created this Project, with that human's permissions as they stand
  at the call, in this Project's Organization only. `GET /me` says who that is.
- Projects, Skills and Agents you create are stamped as made by this Project. You see and reach
  those Projects and the ones this Project's configuration lists under *Other Projects*, and no
  others. You change only the Skills and Agents you created, besides the one a Builder chat is
  about; every other Skill and Agent is read-only to you.
- *Other Projects* are not yours: you may read, open (`connect`) and restart them, but never delete
  them.
- Reads are open to every connected Project. Each write is one setting of this Project's Opsiforce
  Public API configuration, all off until someone turns them on: *Edit Skills and Agents*, *Create
  Agents* (with *Agent limit*), *Create Projects* (with *Project limit*, and possibly *Allowed
  Agents*, which lists the only Agents you may create Projects of, and *Workspace for new Projects*,
  where they all go), *Open and restart Projects* (`connect`, `restart`, and a Test Project's `update`
  and `reset`), and *Delete Projects*.
- `GET /.well-known/opsiforce` on the Service host lists its routes, the setting each write needs and
  this Project's settings. Any other path answers `404` with `Opsiforce-Outcome: not supported`.

## Answers and refusals

- An answer is the API's own JSON, a refusal its `application/problem+json`: a `type` ending in the
  reason (`project-not-found`, `permission-denied`, `validation-error`, `name-unavailable`, …) and a
  `detail` that says what to change. Read the `detail`.
- `403` with `Opsiforce-Outcome: not allowed`: the setting named in `Opsiforce-Setting` is off. The
  `detail` names it, links to it and says who can change it. Tell the user that in plain words, with
  the link; do not retry or look for another way round.
- `403` `not allowed` with `Opsiforce-Setting: createdProjectAgents` on `POST /projects`: this Project may
  create Projects only of the Agents listed there. Use one of those, or tell the user who can add
  the Agent. With `createdProjectsWorkspace`, leave `workspaceId` out: your Projects go to the
  chosen Workspace.
- `409` `max-created-agents`: this Project already has as many Agents as *Agent limit*
  allows. Tell the user who can raise it.
- `409` `max-created-projects`: this Project already has as many Projects as *Project limit*
  allows. Delete one you created, or tell the user who can raise it.
- `409` `chain-too-deep` on `POST /projects`: this Project was itself made by a chain of Projects as
  deep as the platform allows. Do not retry; do the work in this Project or ask the user.
- `404` `project-not-found` for a Project the user named: this Project neither created it nor lists
  it under *Other Projects*, or its creator cannot see it. Tell the user what the `detail` says; do
  not look for another way in.
- `permission-denied` without that header: the creator lacks the `permission` it names, or the Skill
  or Agent was not made by this Project. Tell the user which permission their account needs, or that
  this Project may only read that one.

## Talking to a Project you can open

`POST /projects/<id>/environments/<environmentId>/connect` answers `baseUrl`, `openapiUrl`,
`sessionId` and `build`. For this Project, `baseUrl` is a full URL on the runtime proxy, not on this
Service host: call it exactly as returned, with the same key. Behind it is opencode's own API, and
`openapiUrl` documents it.

```bash
curl -s -X POST "$BASE_URL/api/session/$SESSION_ID/prompt" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' -d '{"id":"msg_…","text":"Research example-org"}'
curl -s "$BASE_URL/api/session/$SESSION_ID/message?limit=50&order=desc" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

- Give every prompt your own `id`: sending the same `id` and text again is harmless.
- `GET $BASE_URL/api/event` streams events. A prompt is done at `session.execution.succeeded`,
  `session.execution.failed` or `session.execution.interrupted` for your Session.
- It needs *Open and restart Projects*, as Connect does; with it off the runtime proxy answers `403`.
  A Project you neither created nor list under *Other Projects* answers `404`.
- `/api/proxy/...` on this Service host answers `404` *not supported*: that is the wrong host, not
  a missing feature. Use `baseUrl`.

## Habits

- List before you create: `GET /skills`, `GET /agents`, `GET /projects`; page with `cursor` until
  `nextCursor` is null.
- After `POST /projects`, poll `GET /projects/<id>` until the Development environment is active, or
  call `POST /projects/<id>/environments/<environmentId>/connect`, which waits for it.
- Delete the Projects you made for a test once you have what you needed from them.
