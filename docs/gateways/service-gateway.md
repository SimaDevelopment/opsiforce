---
kind: explanation
adrs: [0044]
---

# Service Gateway

> How do Apps and Agents reach non-LLM services and platform endpoints with one per-environment token and no provider keys?

## How it works

- Each [ProjectEnvironment](../../GLOSSARY.md) of a [Project](../../GLOSSARY.md) holds one [Gateway Key](../../GLOSSARY.md), its `service` key; the backend validates it, resolves the Project, ProjectEnvironment and tenant, and reaches outside systems itself with credentials it keeps, so an App never holds a provider key ([ADR-0044](../adr/0044-apps-reach-non-llm-services-through-the-backend-owned-service-gateway.md)).
- The same token reaches the platform API only as the `public-api` External Service through the Gate, and a child's runtime through the runtime proxy at `OPSIFORCE_RUNTIME_PROXY_URL` while its `connect_project` switch is on; `/api/v1` itself answers 401 to it ([API Token](../public-api/api-token.md), [ADR-0087](../adr/0087-the-public-api-is-a-built-in-external-service-and-pods-reach-it-only-through-the-gate.md)).
- The endpoint is public to the cluster and authenticates on the token alone, because pods call it without the edge's identity headers; the gateway path is meant to be cluster-internal, so a leaked token is useless from the internet.
- Outside systems are reached as [External Services](../../GLOSSARY.md) through the [Gate](../external-services/gate.md). `POST /api/gateway` (`{service, payload}`) dispatches to a provider registry whose only provider is email, and the controller refuses `service: "email"` with `400`, so no call through it reaches a provider.
- The `service` token is created with the Project, injected as `SERVICE_GATEWAY_API_KEY` next to `SERVICE_GATEWAY_URL`, and revoked by status on Project deletion; gateway keys live in their own table, never among the LLM virtual keys.
- The same token resolves the calling environment for [Schedule](../projects/schedule.md) registration, the [App Readiness](../projects/app-readiness.md) and [Agent Status](../agent-system/agent-status.md) pushes, and the [Gate](../external-services/gate.md), which is mounted outside the gateway prefix and reached through a second base URL, `EXTERNAL_SERVICES_URL`.
- Bifrost and the Service Gateway are separate channels: Bifrost carries LLM calls with two keys per Project, the `service` key carries every other call a pod makes to the platform, External Services included ([LLM Gateway](llm-gateway.md)).

```
pod ──Bearer gw-… (SERVICE_GATEWAY_API_KEY)──┬─▶ /api/gateway/{schedules,app,agent}   Schedules, Go-live, Agent Status
                                             ├─▶ EXTERNAL_SERVICES_URL               the Gate, then the service
                                             └─▶ OPSIFORCE_RUNTIME_PROXY_URL         a child's runtime (connect_project on)
```

## Code

- `backend/src/gateway/` — the token guard, the key service, the call tokens and the `/api/gateway` dispatcher.
- `project_gateway_keys` in `backend/db/schema.ts` — the per-ProjectEnvironment tokens, with `gateway_audit_logs` beside it.
- `backend/src/pod/pod.template.ts` — token and base URL injection.

## Related

- [LLM Gateway](llm-gateway.md) — the LLM channel and its virtual keys.
- [Schedule](../projects/schedule.md) — registers cron jobs over the token.
- [App Readiness](../projects/app-readiness.md) — pushes Go-live over the token.
- [Gate](../external-services/gate.md) — the External Service calls that reuse the token.
- [API Token](../public-api/api-token.md) — how a pod's key reaches the public API through the Gate.
