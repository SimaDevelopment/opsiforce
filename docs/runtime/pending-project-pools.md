---
kind: explanation
adrs: [0041]
---

# Pending Project Pools

> How does "New [Project](../../CONTEXT.md)" hand back a running environment in well under a second?

## How it works

### What waits in the pool

- A pool of complete Projects with no tenant sits in status `pending`; creating a Project claims one and rewrites ownership in place ([ADR-0041](../adr/0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md)).
- Each slot is a `projects` row with no tenant, an [Agent](../../CONTEXT.md) and a directory; an orphan Bifrost team with chat and backend virtual keys ([LLM Gateway](../gateways/llm-gateway.md)); a service-gateway key row; and a running pod with the workspace seeded and OpenCode reachable.
- No LLM call happens against a slot before it is claimed, so cost attribution is meaningful from the claim onward.
- Each agent in `agent-config/agents.json` declares its own `poolSize`, which the boot reconciler mirrors onto its `agents` row; the pool reads that column for Built-in Agents only, so a Custom Agent never has a pool, and a Built-in Agent that declares `platformApi` is never claimed from one. `POOL_SIZE_OVERRIDE` caps every agent's effective size, and `0` in either place disables the pool for that agent or globally.

### Boot and claim

- On boot the pool deletes any pod still labelled `opsiforce.io/pool=warm`. At boot and every 60 seconds an integrity job recovers rows stuck in `claiming`, checks that every pending slot's pod is present and healthy, recycles slots whose baked agent version or model is stale, and replenishes each agent to its target.
- A claim first checks the Organization's Projects [Limit](../../CONTEXT.md) in the same transaction ([Limit](../organization/limit.md)), then reserves a `pending` row with `FOR UPDATE SKIP LOCKED`, flips it to `claiming`, checks its pod is ready, patches the Bifrost team's budgets to the tenant defaults and its customer, delivers the Agent's files ([Dynamic Delivery](../agent-system/dynamic-delivery.md)), writes the tenant onto the key rows, flips to `active`, returns the Project, and replenishes asynchronously.
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

- When the backend crashes mid-claim, the integrity job finds rows in `claiming` older than 30 seconds and retries the Bifrost patches, then delivers and finishes the claim, destroying the slot when a patch or the delivery fails.
- When the pool for the requested agent is empty, its reserved slot has no ready pod, a Bifrost patch fails three times in a row, or delivery or finalizing fails, creation falls through to the direct path with no user-visible error.
- When the Organization is at its Projects Limit, the claim reserves nothing and the create is refused instead of falling through.
- When `poolSize` is lowered, existing slots are claimed naturally and no new ones are created.

## Code

- `backend/src/pool/` — boot pass, claim, replenish, recycle and recovery.
- `backend/src/bifrost/bifrost.service.ts` — orphan team creation and the customer reassignment at claim.
- `backend/src/project/project.service.ts` — Project creation tries the pool before the direct path.
- `agent-config/agents.json` — the per-agent pool size the reconciler mirrors onto `agents.pool_size`.

## Related

- [Pod Lifecycle](pod-lifecycle.md) — how a claimed environment behaves from then on.
- [LLM Gateway](../gateways/llm-gateway.md) — the orphan team a slot carries until claim.
- [Storage](storage.md) — pool slots appear as an unattributed bucket.
