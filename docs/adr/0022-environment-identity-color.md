---
status: superseded by ADR-0040
---

# Environment identity color: a stored registry attribute, distinct from status color

We give each tenant `Environment` (the registry row from [0001](0001-environment-vs-project-environment.md)) a stored **color** — a validated `#RRGGBB` hex — and render it as a small dot per environment beneath each Project's name in the sidebar, so the environments a Project runs in are legible at a glance. Color is a *stored* attribute of the `Environment`, not a value derived at render from the environment's name or id.

Color is an **identity** axis, deliberately orthogonal to the existing **status** colors (`frontend/src/components/project/environments/env-status.ts`, `STATUS_META`: active/starting/suspended/failed). Identity color answers *which* environment this is; status color answers *how a running instance is doing*. The sidebar dot encodes identity only: a Project shows one dot per `Environment` it has a `ProjectEnvironment` in — Development included — present whenever that instance **exists**, independent of whether the App is live there. (See the *Environment Color* entry in `CONTEXT.md`.)

The two protected Environments are seeded with defaults (Development `#3B82F6`, Production `#22C55E`); new custom Environments get a rotating default; every color — protected ones included — is editable by an admin via a full color picker in the Settings → Environments registry. The picker is built from Kobalte's color primitives (`color-area` + `color-slider` + a hex `color-field`), which the installed `@kobalte/core@0.13.11` already ships, so no new dependency. A migration backfills existing rows deterministically by `createdAt`.

The sidebar resolves color through the **registry**, not the project payload: `GET /projects` grows a single `environmentIds` array per project (the environments it runs in), and the frontend joins those ids against the cached `useEnvironments()` registry to get name + color. Color therefore has exactly one source. Arbitrary hex is kept visible on the light sidebar with a thin contrast ring drawn on every dot.

## Considered options

- **Derive color at render from the environment id/slug** (a hashed categorical palette). Zero backend, but the color is arbitrary, can collide, and *drifts* when the palette or environment set changes — fatal for an identity signal whose entire value is "green always means Production." Rejected.
- **Curated fixed swatch palette, stored as a key** (not a hex). Guarantees legibility and sidesteps the Tailwind-v4 dynamic-class problem, but caps expressiveness; the owner wanted free choice. Rejected in favour of a free hex picker plus a rendering-time contrast ring.
- **Denormalize color into the `/projects` payload.** One fewer client-side join, but it copies the color onto every project row and forces a recolor to bust two caches. Rejected: membership-only `environmentIds` + a registry join keep color single-sourced.
- **Gate the dot on App liveness (`hasApp`) instead of instance existence.** Matches the loose word "deployed," but re-entangles identity with status and makes dots appear/disappear as pods suspend and resume. Rejected in favour of Exists semantics.
- **Make the dots interactive** (deep-link to that Active environment). Deferred — this is an indicator; the environments popover already owns environment actions, and interactivity can be added later without redesign.

## Consequences

- New non-null `environments.color` column (+ migration + backfill); `EnvironmentResponse` and the frontend `Environment` type gain `color`; the backend validates `^#[0-9A-Fa-f]{6}$` so a malformed value cannot persist.
- `GET /projects` list items gain `environmentIds` and, as incidental cleanup, drop fields no consumer reads (`tenantId, agentId, bifrostProjectId, description, disabled, timezone, pinnedAt, pinnedEnvironmentId, appName, appDescription, lastActiveAt`, plus five never on the TS type: `directory, podIp, sessionId, platformVersion, updatedAt`). The list/detail select and the `Project` type stay shared — no list/detail type split.
- Recoloring or renaming an environment must invalidate the environments query; the projects payload (bare ids) needs no invalidation.
- A `ProjectEnvironment` whose `environmentId` is null (legacy/unlinked) resolves to no dot — unmapped ids are skipped rather than given a fallback colour.
- A new `frontend/src/components/ui/color-picker.tsx` wrapper over Kobalte color primitives; the dot renders via inline `style={{ 'background-color': hex }}`, not a `bg-*` Tailwind class.
- Color is now available to reuse beyond the sidebar (environments popover, prod banner) for a consistent identity treatment — out of scope for this change.
