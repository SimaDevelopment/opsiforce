---
kind: explanation
terms: [Withheld]
---

# Model provider access

> Which Organizations can use each Built-in model provider, and how does a platform admin change it?

## How it works

- A Built-in is offered to **every** Organization, the ones listed in `model_provider_availability_tenants` withheld, or only to **chosen** Organizations, the listed ones; `model_provider_availability` holds the mode by the provider's name (its `bifrost_key` when set), and a provider with no row there is offered to every Organization with none withheld ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-project-keys.md)).
- **Add model provider** asks a platform admin **Who can use it**: **Every organization**, including ones added later, or **Only organizations I choose**, picked in a searchable list; the create request's `availability` starts the provider's mode and list ([Opsiforce model provider](opsiforce-model-provider.md)).
- Every Built-in row's ⋮ menu offers a holder of `can_manage_platform_model_providers` **Organization access**, a dialog listing every Organization (searchable, 8 a page, **All** or **Without access**) with an access switch per Organization and **Give access to all shown** and **Remove access from all shown**. Every change, the switch below included, stays a draft, marked "Gets access on save" or "Loses access on save", until **Save**, which warns how many Organizations lose access and then sends the changes one at a time; switching access off makes the provider [Withheld](../../GLOSSARY.md) from that Organization. Cancel or closing the dialog discards the draft. `PUT /api/platform-model-providers/<name>/access/<tenantId>` with `{ withheld }` updates its availability and rewrites that Organization's keys; `GET /api/platform-model-providers/access` reads every provider's mode and every Organization's id, name and withheld providers.
- A holder of both permissions sees the Built-ins their current Organization is withheld from at the bottom of their card, under **No access in this organization**, greyed out with the gateway's status, no switch or weight, and their ⋮ menu; an Organization admin without the platform permission doesn't see them at all. The page matches the current Organization by its `name`, which the access read carries for each Organization.
- The same dialog's **Give organizations added later access automatically** switch is `PUT /api/platform-model-providers/<name>/availability` with `{ mode }` (`every` when on, `chosen` when off); it keeps every existing Organization's access and touches no key ([ADR-0077](../adr/0077-model-providers-live-in-bifrost-with-a-thin-row-projected-into-project-keys.md)).
- A withheld provider leaves the Organization's keys, reachability, dictation and Settings page, and its admin's save can't name it; the Organization's own row of it is kept, so giving access again restores its switch and weight. Nothing checks which Agents use the withheld provider's models. A new Organization starts with every provider offered to every Organization and none offered to chosen ones.

## Code

- `backend/src/model-provider/model-provider.service.ts` — availability, and the effective rows it filters.
- `backend/src/model-provider/platform-model-providers.service.ts` — the access and mode routes.
- `frontend/src/pages/model-providers/tenant-access.tsx` — the access dialog, its draft and its switch for Organizations added later.
- `frontend/src/pages/model-providers/add-provider-dialog.tsx` — the Who can use it choice.

## Related

- [Opsiforce model provider](opsiforce-model-provider.md) — the Built-ins this access applies to.
- [Model provider](model-provider.md) — the format cards an Organization switches and weights its providers on.
- [Permissions](permissions.md) — the platform permission the dialog needs.
