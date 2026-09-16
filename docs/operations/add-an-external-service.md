---
kind: operations
---

# Add an external service

> Plug a new inbound service into the external-services template with one definition, one barrel line and one skill.

## Prerequisites

- The provider's webhook semantics: how it signs or authenticates deliveries, whether it can be told a permanent reject, its payload shape and whether media arrives inline or by reference ([Service template](../external-services/service-template.md)).
- A service name that is not one of the reserved `usage`, `webhooks`, `agent`, `admin` or `services`.

## Steps

1. Write one service definition under `backend/src/external-services/<service>/`: how to verify a request, how to pull routing keys from a payload, how to turn a payload into typed messages and attachments, what to do when a message routes nowhere, the identity projection, any extra agent or admin routes as route-table entries, and optionally a provisioning hook for new environments and what a Publish should carry forward.
2. Add the definition class to the definitions barrel in `backend/src/external-services/`; the module derives its providers from that array.
3. Write the agent skill under `agent-config/skills/<service>/SKILL.md`: how to read identity from `GET $EXTERNAL_SERVICES_URL/<service>/identity`, how to replace the App template's catch-all 501 stub with a handler for `POST /api/external-services/<service>`, and how to read the shared `messages` and `attachments` tables with a `service = '<service>'` filter including the catch-up query over undelivered rows.
4. Leave the rest to the module: the three mounts and their guards, the transaction, deduplication, metering, the doorbell, the publish hook, Datasette exposure and the Admin Usage view need no change, and no DDL is added.

## Verify

- The backend boots; a reserved or duplicate name is refused at startup.
- `GET agent/<service>/identity` answers 200 with the service's empty shape for a fresh environment.
- A signed test delivery answers 200, a row appears in the environment's `external-services.db` in Datasette, the Usage view counts it, and the App's stub answers 501 until the handler is implemented.
