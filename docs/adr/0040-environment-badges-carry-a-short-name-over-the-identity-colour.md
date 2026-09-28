# Environment badges carry a short name over the identity colour

The sidebar shows which Environments a Project runs in. A colour alone distinguishes environments only once a reader has learnt the palette, and identity that needs a hover is not at-a-glance identity. **Each Environment renders as a badge whose text is its Badge Label, stored as `environments.short_name`, over its Environment Color as the badge's tint.**

Colour is a *stored* attribute of the tenant `Environment` (the registry row from [ADR-0001](0001-environment-vs-project-environment.md)), a validated `#RRGGBB` hex, not a value derived at render. It is an **identity** axis, orthogonal to the status colours: identity answers *which* environment this is, status answers *how a running instance is doing*. The protected Environments are seeded with defaults (Development `#3B82F6`, Production `#22C55E`), and an admin edits every colour and Badge Label from the Environment registry in Settings, with a colour picker built on Kobalte's colour primitives.

A Project shows one badge per Environment it has a ProjectEnvironment in, Development included, whenever that instance exists, independent of whether the App is live there. The sidebar resolves name, label and colour through the registry: `GET /projects` carries bare `environmentIds`, and the frontend joins them against the cached `useEnvironments()` registry, so colour has one source.

## Considered options

- **Derive the label from the Environment Slug only.** Rejected as the sole source: `staging` and `stage` both abbreviate ambiguously, and an admin should be able to choose `STG`. The slug remains the fallback, so the badge is never empty.
- **Derive colour at render from the environment id or slug** (a hashed palette). Rejected: the colour is arbitrary, can collide, and drifts when the palette or environment set changes — fatal for a signal whose value is "green always means Production".
- **A curated swatch palette stored as a key.** Rejected in favour of a free hex picker; the badge tint is mixed from the hex at render.
- **Denormalize colour into the `/projects` payload.** Rejected: it copies the colour onto every project row and makes a recolour bust two caches.
- **Show the badge only while the App is live.** Rejected: it re-entangles identity with status and makes badges appear and disappear as pods suspend and resume.

## Consequences

- Nullable `environments.short_name`, validated as two to five letters or digits; migration 0058 backfills labels for the common slugs.
- The badge falls back to the Environment Slug's first letters, uppercased, when the Badge Label is empty.
- The backend validates `^#[0-9A-Fa-f]{6}$`, so a malformed colour cannot persist.
- Recolouring or renaming an environment invalidates the environments query; the projects payload (bare ids) needs no invalidation. An id with no registry row renders no badge.
