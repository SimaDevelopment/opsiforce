# App Auth is enforced per `ProjectEnvironment`, seeded once from Development

`auth_mode` (`public` | `manual` | `managed`) is a per-`ProjectEnvironment` column, and enforcement must match it: App Auth is a Traefik `Middleware` + `IngressRoute` built by `ProjectAuthService`, and a published environment's host with no middleware of its own falls through to the wildcard app route unprotected. **App Auth is keyed by the routing id (the environment id), seeded once from Development at first publish, and managed independently per environment after that.**

**Keyed by routing id.** Resources are named `opsiforce-project-{routingId}-*` and match that environment's own hosts at priority 100, above the wildcard route. Development's environment id equals its project id ([ADR-0002](0002-development-environment-reuses-project-id.md)), so Development needs no special case.

**Seeded by cloning.** The first publish clones Development's middleware spec to the new environment under the new resource name. One mode-agnostic path carries `manual`'s client secret (which lives only inside the middleware) and `managed`'s tenant-role claims without re-deriving either. Only when Development is `managed` and its middleware is missing does the seed apply `managed` fresh. Redeploys never touch auth.

**Early and fail-closed.** The seed runs before the published App can serve. If Development is `manual` or `managed` and the middleware cannot be created, the publish fails. For a security control, "never expose" beats "never block a deploy".

**Why `managed` works at once and `manual` may not.** One shared `opsiforce-apps` identity-provider client with a `*` redirect URI and a tenant-wide `assertClaims` role accepts any environment's callback, so `managed` works the moment it is cloned. `manual` points at the customer's own identity provider, which must whitelist each environment's callback URLs; the Auth dialog lists them, and a freshly published `manual` environment is protected with sign-in failing until the customer registers them.

**Managed per environment.** Auth is opened per environment from the environments popover, not the project menu, so no action depends on whichever environment happens to be active.

## Considered options

- **Re-key with a new `opsiforce-env-{envId}` prefix.** Rejected: it renames Development's live middleware, orphaning resources and needing a cleanup migration.
- **Mode-switch inherit as the main path** (re-derive `managed` via `applyManaged`, copy `manual`'s config explicitly). Rejected: two code paths and more surface; cloning the spec carries `manual`'s secret for free.
- **Late or fail-open seed.** Rejected: a real exposure window and the risk of silently shipping an unprotected environment.
- **OIDC config in the database.** Rejected: the middleware is already the authoritative store (`getConfig` reads it back), and a copy would be a second source of truth for a client secret.

## Consequences

- OIDC config stays in the middleware; there is no schema for it.
- Deleting a non-Development environment removes its middleware and IngressRoute.
- `managed-auth-sync` (run when a tenant's external tenant name changes) fans out to **every** `managed` environment by routing id.
- The `*` redirect URI on `opsiforce-apps` is an open-redirect smell this relies on but does not fix.
- The auth endpoints are `GET/PUT /projects/:id/environments/:environmentId/auth`; Development is addressed as `environmentId == id`.
- Each environment answers on two hostnames and the middleware's callback is the relative `/oidc/callback`, so `manual` owners register one callback URL per hostname ([ADR-0012](0012-public-app-hostnames-carry-environment-slug.md)).
