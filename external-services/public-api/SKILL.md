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
- Projects, Skills and Agents you create are stamped as made by this Project. Those are the only
  Projects you can see or reach, and the only Skills and Agents you can change, besides the one a
  Builder chat is about; every other Skill and Agent is read-only to you.
- Reads are open to every connected Project. Each write is one setting of this Project's Opsiforce
  Public API configuration, all off until someone turns them on: *Edit Agents and Skills*, *Create
  Agents*, *Create Projects* (with *Created Projects limit*), *Manage created Projects* (connect, restart,
  Test Project update and reset) and *Delete created Projects*.
- `GET /.well-known/opsiforce` on the Service host lists its routes, the setting each write needs and
  this Project's settings. Any other path answers `404` with `Opsiforce-Outcome: not supported`.

## Answers and refusals

- An answer is the API's own JSON, a refusal its `application/problem+json`: a `type` ending in the
  reason (`project-not-found`, `permission-denied`, `validation-error`, `name-unavailable`, …) and a
  `detail` that says what to change. Read the `detail`.
- `403` with `Opsiforce-Outcome: not allowed`: the setting named in `Opsiforce-Setting` is off. The
  `detail` names it, links to it and says who can change it. Tell the user that in plain words, with
  the link; do not retry or look for another way round.
- `409` `max-created-projects`: this Project already has as many Projects as *Created Projects limit*
  allows. Delete one you created, or tell the user who can raise it.
- `409` `chain-too-deep` on `POST /projects`: this Project was itself made by a chain of Projects as
  deep as the platform allows. Do not retry; do the work in this Project or ask the user.
- `permission-denied` without that header: the creator lacks the `permission` it names, or the Skill
  or Agent was not made by this Project. Tell the user which permission their account needs, or that
  this Project may only read that one.

## Habits

- List before you create: `GET /skills`, `GET /agents`, `GET /projects`; page with `cursor` until
  `nextCursor` is null.
- After `POST /projects`, poll `GET /projects/<id>` until the Development environment is active, or
  call `POST /projects/<id>/environments/<environmentId>/connect`, which waits for it.
- Delete the Projects you made for a test once you have what you needed from them.
