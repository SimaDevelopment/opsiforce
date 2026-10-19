---
name: service-new
description: Say what the upstream system is and when an Agent should reach for this service, in the words a user would use.
---

# New External Service

What the upstream is, the thing a user names (a project, a board, a mailbox) and how this Project's configuration decides which of them it reaches.

## Setting up a client

How each client this service serves (curl, the upstream's CLI or SDK, App code) reaches `https://<slug>.$EXTERNAL_SERVICES_HOST` with `$SERVICE_GATEWAY_API_KEY`, with every flag that keeps a client from prompting.

## The upstream API

The upstream API this service passes through, its version and a link to its docs.

## Differences from the upstream

What a request through this service can't do, or does differently, and the setting a refusal names.

## Conventions

Ids, paging, eventual consistency and writes that are not idempotent.

## Events

Each Event type the service delivers, when it arrives, how a Project chooses to hear it, and the keys of its `data`. Remove this section when the service delivers none.

## Invented endpoints

Each `handle` route's request (method, path, query, body) and answer, since no upstream docs cover them. Remove this section when the service has none.

## Where the upstream keeps its own record

Where a person checks, in the upstream itself, what was done through this service.
