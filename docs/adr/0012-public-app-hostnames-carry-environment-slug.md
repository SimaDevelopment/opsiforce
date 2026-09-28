# Public app hostnames carry an immutable Environment slug

A bare `{envId}.apps…` URL is an opaque uuid that gives no hint whether a link points at Development or Production. **The public app hostname is `{envId}-{slug}.apps…`**, where the slug is an immutable, DNS-safe column on the tenant Environment registry: seeded `dev` and `prod` for the protected environments. For custom ones the create dialog prefills it from the whole name (lowercased, diacritics stripped, non-alphanumeric runs collapsed to dashes, capped at 26 chars so the label fits DNS's 63) and the admin may edit it that one time before saving — validated to `[a-z0-9-]`, no leading or trailing dash, unique per tenant (which inherently blocks `dev`/`prod`, owned by the protected rows) — then it is immutable; renames never touch it. A name with no latin letters or digits is fine: the prefill comes out empty and the admin types the slug by hand.

The routing key is the environment id ([ADR-0002](0002-development-environment-reuses-project-id.md): Development's id equals its project's id); the slug is a readable discriminator the resolve path validates. The canonical host is always suffixed, including Development, and it is the only host the platform ever hands out (Copy URL, `APP_PUBLIC_URL`). The legacy bare `{envId}` host also serves — every environment answers on exactly two hostnames, so pre-slug links keep working without a redirect hop. A wrong suffix answers with a 308 to the canonical host.

Per-environment App Auth covers both: the auth IngressRoute matches the canonical and the bare host (priority 100, above the catch-all `HostRegexp`), and the OIDC middleware uses a relative callback (`/oidc/callback`), so each hostname completes its own sign-in and carries its own host-scoped session cookie — widening the cookie domain instead would share it across every app subdomain, i.e. with arbitrary user-authored code. Managed mode needs nothing extra (the shared identity-provider client trusts any app subdomain); for manual mode the owner must register **both** callback URLs with their identity provider — the Auth dialog lists them, and that registration is the owner's responsibility.

Scope is the public apps host only. The `.preview.`, vscode, and db hostnames are internal and keep their bare env-id labels.

Rejected alternatives:

- **Project-anchored hostnames** (`{projectId}-{slug}` for every environment): a stable, guessable base per project, but it changes the routing key for published environments and forces a larger migration; the readable-discriminator goal doesn't need it.
- **Slug derived from the live registry name**: no schema change, but renaming a custom environment (allowed, tenant-wide) would change every bound project's public URL at once — auth IngressRoute rebuild fan-out, broken bookmarks and registered OIDC callbacks.

## Consequences

- The uuid's fixed 36-char length is load-bearing for parsing: chars 0–35 of the label are the env id, 37+ are the slug. Do not introduce non-uuid environment ids.
- The hostname regexes in the Traefik webapp route and the Go proxy match `[a-z0-9-]+`.
- Manual-auth owners must register both hostnames' OIDC callbacks (the Auth dialog lists both URLs). Managed mode is unaffected — the shared identity-provider client trusts any app subdomain.
- Auth middlewares/IngressRoutes that existed before the rollout keep their pre-slug host until that environment's auth is saved again — there is deliberately no automatic reconcile. Until re-saved, such an environment is protected on its old bare host but its canonical host serves unauthenticated; re-saving auth from the Environments panel closes that.
- `APP_PUBLIC_URL` baked into running pods is stale until the next pod recycle; idle suspension makes that self-healing.
- The wildcard DNS/TLS entry `*.apps…` already covers suffixed labels — no certificate or DNS change.
- The migration backfilling slugs for existing custom environments dedupes numerically (`staging`, `staging-2`) since no admin is present to resolve a conflict; only the create dialog validates interactively.
- An admin can hand-pick a regrettable slug and keep it forever (the GitHub-repo-name trade); the create dialog shows the resulting URL preview to make the commitment visible.
