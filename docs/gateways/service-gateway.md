---
kind: explanation
adrs: [0044]
---

# Service Gateway

> How do Apps and Agents reach non-LLM services and platform endpoints with one per-[Project](../../CONTEXT.md) token and no provider keys?

## How it works

- Each Project holds one gateway token; the Agent calls the gateway with it, and the gateway validates the token, resolves the Project, [ProjectEnvironment](../../CONTEXT.md) and tenant, and forwards to the real provider with centrally held credentials ([ADR-0044](../adr/0044-apps-reach-non-llm-services-through-the-backend-owned-service-gateway.md)).
- The endpoint is public to the cluster and authenticates on the token alone, because pods call it without the edge's identity headers; the gateway path is meant to be cluster-internal, so a leaked token is useless from the internet.
- A provider registry keyed by service name means adding a provider is one class plus one line in the module factory; the email provider forces the sender to the configured address, so an Agent cannot spoof senders or manage the provider account.
- The token is created with the Project, injected as `SERVICE_GATEWAY_API_KEY` next to `SERVICE_GATEWAY_URL`, and revoked by status on Project deletion; gateway keys live in their own table, never among the LLM virtual keys.
- The same token resolves the calling environment for [Schedule](../projects/schedule.md) registration, the [App Readiness](../projects/app-readiness.md) and [Agent Status](../agent-system/agent-status.md) pushes, and the external-services agent endpoints ([Service template](../external-services/service-template.md)), which are mounted outside the gateway prefix and reached through a second base URL, `EXTERNAL_SERVICES_URL`.
- Bifrost and the Service Gateway are separate channels: Bifrost carries LLM calls with two keys per Project, the gateway carries every other external HTTP service with one token and providers built into the backend ([LLM Gateway](llm-gateway.md)).

```
Agent Pod ──POST /api/gateway──▶ GatewayController (token-guarded)
  Bearer gw-…                      └─▶ ProviderRegistry ─▶ EmailProvider ─▶ Mailgun
  { service, payload }
```

## Code

- `backend/src/gateway/` — the controller, the token guard, the key service and the provider registry.
- `project_gateway_keys` in `backend/db/schema.ts` — the per-Project tokens, with `gateway_audit_logs` beside it.
- `backend/src/pod/pod.template.ts` — token and base URL injection.

## Related

- [LLM Gateway](llm-gateway.md) — the LLM channel and its virtual keys.
- [Schedule](../projects/schedule.md) — registers cron jobs over the token.
- [App Readiness](../projects/app-readiness.md) — pushes Go-live over the token.
- [Service template](../external-services/service-template.md) — the inbound endpoints that reuse the token.
