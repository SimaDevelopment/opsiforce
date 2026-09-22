# Environment badges carry a short name over the identity colour

ADR-0022 rendered an Environment's identity as a small coloured dot per environment beneath a Project's name. A dot distinguishes environments only once a reader has learnt the palette, so the sidebar now shows a badge whose text is the Badge Label, stored as `environments.short_name` (migration 0058), with the Environment Color surviving as the badge's background tint. This supersedes ADR-0022's rendering decision, not its data model: colour is still a stored registry attribute, still an identity axis distinct from status, and still edited from the Environment registry in Settings.

## Considered options

- **Keep the dot and add a tooltip.** Rejected: identity that needs a hover is not at-a-glance identity.
- **Derive the label from the Environment Slug only.** Rejected as the sole source: `staging` and `stage` both abbreviate ambiguously, and an admin should be able to choose `STG`. The slug remains the fallback, so the badge is never empty.

## Consequences

- Nullable `environments.short_name`, validated as two to five letters or digits; migration 0058 backfills labels for the common slugs.
- The badge falls back to the Environment Slug's first letters, uppercased, when the Badge Label is empty.
