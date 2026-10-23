---
kind: explanation
terms: [Ready Projects]
adrs: [0041, 0093]
---

# Pending Project Pools

> How does "New [Project](../../GLOSSARY.md)" hand back a running environment in well under a second?

## How it works

### What waits in the pool

- A pool of complete Projects with no tenant sits in status `pending`; creating a Project claims one and rewrites ownership in place ([ADR-0041](../adr/0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md)).
- Each slot is a `projects` row with no tenant, an [Agent](../../GLOSSARY.md) and a directory; an orphan Bifrost team with chat and backend virtual keys ([LLM Gateway](../gateways/llm-gateway.md)); a service-gateway key row; and a running pod with the workspace seeded and OpenCode reachable.
- No LLM call happens against a slot before it is claimed, so cost attribution is meaningful from the claim onward.
- Each agent in `agent-config/agents.json` declares its own `poolSize`, which the boot reconciler mirrors onto `agent_settings.warm_pool_size`. A Custom Agent's [Ready Projects](../../GLOSSARY.md) count is the same column, 0 to 3, set as "Keep N ready" in its Settings and counted only while the Agent is enabled in its Organization and has an Agent Profile at its Default environment (Agent) ([ADR-0093](../adr/0093-an-agent-sets-the-resources-and-ready-projects-of-the-projects-created-from-it.md)). `POOL_SIZE_OVERRIDE` caps every agent's effective size, and `0` in either place disables the pool for that agent or globally.
- A slot is built at its Agent's [Resources](../../GLOSSARY.md), read from `agent_pod_settings` (no row is Small), and boots the Agent's package (`custom` for every Custom Agent), so the Agent's own files arrive only at the claim.

### Boot and claim

- On boot the pool deletes any pod still labelled `opsiforce.io/pool=warm`. At boot and every 60 seconds an integrity job recovers rows stuck in `claiming`, checks that every pending slot's pod is present and healthy, recycles slots whose baked agent version or model is stale, whose Resources are not the Agent's, whose Agent no longer keeps a pool, or that sit above the pool size, and replenishes each agent to its target. Saving an Agent's settings, publishing it, disabling or enabling it, and a Duplicate or Import that keeps a warm pool each queue the same job at once.
- A claim first checks the Organization's Projects [Limit](../../GLOSSARY.md) in the same transaction ([Limit](../organization/limit.md)), then reserves a `pending` row of the Agent whose Resources match the Agent's current ones with `FOR UPDATE SKIP LOCKED`, flips it to `claiming`, checks its pod is ready, patches the Bifrost team's budgets to the tenant defaults and its customer, writes the Organization's Model providers into the slot's `chat` key, delivers the Agent's files ([Dynamic Delivery](../agent-system/dynamic-delivery.md)) and announces them to the running OpenCode — `agent-control` touches a marker under `.opencode/` (config, for the new `default_agent`), `.opencode/agents/` and `.opencode/skills/`, and the claim reads `GET /api/agent` and `GET /api/skill` back until the Agent and every delivered Skill are served ([ADR-0030](../adr/0030-agent-owned-file-changes-need-no-opencode-reload.md)), destroying the slot when they are not, writes the tenant onto the key rows, flips to `active`, returns the Project, and replenishes asynchronously.
- A slot whose pod is missing, terminating, in `ImagePullBackOff` or still not ready after a 90-second grace period is recycled: pod deleted, Bifrost resources revoked, workspace removed, row deleted, fresh slot created.
- The agent update sweep skips unclaimed slots because its migration job would mount the workspace the live pool pod is using ([Agent Updates](../agent-system/agent-updates.md)); claimed Projects migrate normally.

## States

Project statuses a slot passes through.

| State | What happens |
|---|---|
| `pending` | Fully provisioned, tenant-less, waiting to be claimed |
| `claiming` | Reserved by one claim; Bifrost and key rows are being reassigned |
| `active` | Owned by a tenant; an ordinary Project from here on |

## Edge cases

- When the backend crashes mid-claim, the integrity job finds rows in `claiming` older than 30 seconds and retries the Bifrost patches and the Model provider write, then delivers and finishes the claim, destroying the slot when a patch, the write or the delivery fails.
- When the pool for the requested agent is empty, its reserved slot has no ready pod, a Bifrost patch or the Model provider write fails three times in a row, or delivery or finalizing fails, creation falls through to the direct path with no user-visible error.
- When the Organization is at its Projects Limit, the claim reserves nothing and the create is refused instead of falling through.
- When `poolSize` or `POOL_SIZE_OVERRIDE` is lowered, the integrity job recycles the oldest slots above it.
- When a Custom Agent is deleted, its unclaimed slots are destroyed before its row.

## Code

- `backend/src/pool/` — boot pass, claim, replenish, recycle and recovery.
- `backend/src/bifrost/bifrost.service.ts` — orphan team creation and the customer reassignment at claim.
- `backend/src/project/project.service.ts` — Project creation tries the pool before the direct path.
- `agent-config/agents.json` — the per-agent pool size the reconciler mirrors onto `agent_settings.warm_pool_size`.
- `backend/src/agent/agent-pod-settings.ts` — an Agent's pod settings for new Projects and the Ready Projects cap.

## Related

- [Pod Lifecycle](pod-lifecycle.md) — how a claimed environment behaves from then on.
- [LLM Gateway](../gateways/llm-gateway.md) — the orphan team a slot carries until claim.
- [Storage](storage.md) — pool slots appear as an unattributed bucket.
