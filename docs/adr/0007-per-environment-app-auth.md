# App Auth is enforced per `ProjectEnvironment`, seeded once from Development

`auth_mode` (`public` | `manual` | `provider` | `app_users`) is a per-`ProjectEnvironment` column, and enforcement must match it: App Auth is a Traefik `Middleware` + `IngressRoute` built by `ProjectAuthService`, and a published environment's host with no route of its own falls through to the wildcard app route, which signs no one in and where the app proxy refuses every environment whose `auth_mode` is not `public` ([ADR-0012](0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)). **App Auth is keyed by the routing id (the environment id), seeded once from Development at first publish, and managed independently per environment after that.**

**Keyed by routing id.** Resources are named `opsiforce-project-{routingId}-*` and match that environment's own hosts at priority 100, above the wildcard route. Development's environment id equals its project id ([ADR-0002](0002-development-environment-reuses-project-id.md)), so Development needs no special case.

**Seeded by cloning.** The first publish clones Development's middleware spec to the new environment under the new resource name, and a Duplicate does the same for its own Development. One mode-agnostic path carries `manual`'s client secret (which lives only inside the middleware), and a `provider` environment's copy of its Sign-in provider's settings, without re-deriving any of them. The new row takes its Auth mode and Sign-in provider from the middleware it actually cloned, so a switch on Development while a publish is queued cannot leave them disagreeing; a public source also removes any gate the new environment already has. An `app_users` source is the one exception to cloning: its client is the environment itself, so the seed applies `app_users` with the new environment's own client and the source's bypass paths ([ADR-0099](0099-app-users-sign-in-through-an-oidc-provider-the-backend-runs-with-one-client-per-projectenvironment.md)). When the source has no middleware to clone, the seed fails. Redeploys never touch auth.

**Early and fail-closed.** The seed runs before the published App can serve. If Development is protected and the middleware cannot be created, the publish fails. For a security control, "never expose" beats "never block a deploy".

**Why `provider` works at once and `manual` may not.** A `provider` middleware sends every environment's sign-in through its provider's one callback on the sign-in host ([ADR-0097](0097-sign-in-providers-use-the-oidc-plugins-own-callback-host-and-a-cookie-the-app-proxy-strips.md)), so a cloned environment signs visitors in the moment it is published. `manual` points at the customer's own identity provider, which must whitelist each environment's callback URLs; the Auth dialog lists them, and a freshly published `manual` environment is protected with sign-in failing until the customer registers them.

**Managed per environment.** Auth is opened per environment from the environments popover, not the project menu, so no action depends on whichever environment happens to be active.

## Considered options

- **Re-key with a new `opsiforce-env-{envId}` prefix.** Rejected: it renames Development's live middleware, orphaning resources and needing a cleanup migration.
- **Mode-switch inherit as the main path** (re-derive each mode, copy `manual`'s config explicitly). Rejected: one code path per mode and more surface; cloning the spec carries `manual`'s secret for free.
- **Late or fail-open seed.** Rejected: a real exposure window and the risk of silently shipping an unprotected environment.
- **OIDC config in the database.** Rejected: the middleware is already the authoritative store (`getConfig` reads it back), and a copy would be a second source of truth for a client secret.

## Consequences

- `manual` OIDC config stays in the middleware; there is no schema for it. A Sign-in provider, which many environments share, keeps its settings in its own row and rewrites their middlewares when saved ([ADR-0097](0097-sign-in-providers-use-the-oidc-plugins-own-callback-host-and-a-cookie-the-app-proxy-strips.md)).
- Every gate route, and every Custom domain route that carries a gate, runs one shared headers Middleware that drops caller-supplied `X-Oidc-*` headers before the OIDC middleware, because the plugin forwards requests on paths that skip sign-in untouched.
- Deleting a non-Development environment removes its middleware and IngressRoute; deleting a Project, including one a failed create, Duplicate or Import discards, removes those of every one of its environments, so no `manual` client secret outlives its environment.
- The platform-operated `managed` mode is gone: its environments became `public`, and a gate left on an environment that is public, or gone, is removed at backend start.
- The auth endpoints are `GET/PUT /projects/:id/environments/:environmentId/auth`; Development is addressed as `environmentId == id`.
- Each environment's App answers on several hosts and the middleware's callback is the relative `/oidc/callback`, so `manual` owners register one callback URL per host the Auth dialog lists ([ADR-0012](0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)).
