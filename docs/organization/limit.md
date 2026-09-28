---
kind: explanation
terms: [Limit]
adrs: [0076]
---

# Limit

> How is the most an Organization may hold decided and enforced?

## How it works

- A [Limit](../../CONTEXT.md) is one row per key: `global_limits` holds the platform value, and a `tenant_limits` row gives one Organization its own; with no row the Organization follows the platform value, including later changes to it, and a NULL value on either means no limit ([ADR-0076](../adr/0076-organization-limits-are-key-value-rows-that-follow-the-platform-value-unless-overridden.md)).
- Keys are a fixed set: the backend's limit registry maps each key to the query that counts it, and a `CHECK` constraint on both tables holds the same list, so each new key arrives with a migration that extends both constraints, sets its platform value and gives existing Organizations their own row where they keep no limit.
- Today the only key is `projects`, counting the Organization's enabled ordinary Projects; disabled Projects, Builder chats and [Test Projects](../../CONTEXT.md) never count.
- Every path that makes an ordinary Project count — create, duplicate, import, a pooled-slot claim and enable — takes a per-Organization, per-key advisory lock inside its own transaction, then resolves the limit and counts, so concurrent creates cannot overshoot.
- A refused create answers 409 with the limit in the message; the public API types it `limit-reached` ([Contract](../public-api/contract.md)).
- Any member reads the current Organization's limits and counts from `GET /limits`; the sidebar's create menu uses it to disable its agent and import entries once the Projects Limit is reached.
- Settings, Limits edits the platform value and any Organization's own value, lists every Organization with one column per key showing what it holds against its limit, edits one Organization's values in a dialog that chooses the platform value, no limit or its own number per key, and needs `can_manage_platform_limits` — a [Platform-scope permission](../../CONTEXT.md), so the page ignores the selector ([Permissions](permissions.md)).

## Edge cases

- When a limit is lowered below an Organization's current count, nothing is removed; only its next create or enable is refused.
- When an Organization at its limit disables a Project, it may create another, and the disabled one cannot be enabled again until a slot frees up.
- When an Organization is switched back to "Platform value", its own row is removed and it is held to the platform value again on its next create.
- When an Organization first signs in after a Limit was introduced, it has no row of its own and follows the platform value.

## Code

- `backend/src/limit/` — the registry, the lock-and-check, the endpoints and the refusal.
- `backend/src/project/project-limit.ts` — the Projects Limit check every creating transaction runs.
- `frontend/src/pages/limits.tsx` — the Settings page.
- `frontend/src/components/sidebar/create-menu.tsx` — the create menu that disables itself at the limit.

## Related

- [Settings](settings.md) — the section the page lives in.
- [Permissions](permissions.md) — how the Platform-scope permission is granted.
- [Defaults](defaults.md) — the values that are copied into new entities instead of enforced.
- [Test Project](../agent-system/test-project.md) — the Project kind that never counts.
