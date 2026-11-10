# App Users sign in through an OIDC provider the backend runs, with one client per ProjectEnvironment

An owner who wants visitors to sign in to an App, but has no identity provider of their own, needs accounts that Opsiforce keeps. App Auth already gates every protected App with one Traefik `traefik-oidc-auth` Middleware, which speaks only OIDC ([ADR-0007](0007-per-environment-app-auth.md)).

**The backend is an OIDC provider at `<public origin>/api/app-auth`. App Auth `app_users` points an environment's Middleware at it, so the existing gate enforces sign-in, and Apps need no SDK or code of their own.** Concretely:

- **Accounts belong to the Project.** One list of App Users per Project, shared by every ProjectEnvironment. An email is unique within a Project only. The provider signs a visitor in only to Apps of the Project that holds their account.
- **Roles belong to the Project too, and a user holds any number.** The owner names them; the ID token carries them as a `roles` array and the gate forwards them as `X-Oidc-Roles`, a JSON array like the Sign-in provider's `X-Oidc-Groups`. Holders join a role by its id, so a rename is one row.
- **People choose their own passwords through one-time links.** An invite leaves the account without a password; an invite (7 days) or reset (24 hours) link lets the person set one. The backend emails links through the platform's Mailgun account, as Makara does, and the owner can always copy them instead; with Mailgun the sign-in page also offers "Forgot password?", which emails a 1-hour reset link and never says whether the email has an account. Only a hash of each link is stored, one per account and kind, and using it moves `tokens_valid_after`.
- **One client per ProjectEnvironment.** The `client_id` is the environment id. A `redirect_uri` is accepted only when it is `/oidc/callback` on a host the environment's gate route matches, so a visitor still signs in on an address from before an Edit URL, or on one of its [Custom domains](../../GLOSSARY.md) that serves the App on its own host, by the same rule its route follows ([ADR-0105](0105-each-custom-domain-gets-its-own-route-carrying-its-apps-gate-or-the-unprotected-marker-and-signs-in-on-its-own-host.md)). The provider's session cookie lives on the platform's host, so a visitor signed in on one of these addresses skips the form on the others. The `client_secret` is an HMAC of the gate's `OIDC_PLUGIN_SECRET` over the environment id, so nothing is stored and the secret lives only in the Middleware, as `manual`'s does. A first publish applies `app_users` again for the new environment's own client instead of cloning Development's spec.
- **The gate reaches the provider inside the cluster.** The Middleware's provider URL and the discovery document's token and JWKS endpoints use the backend Service's in-cluster address (`APP_USERS_PROVIDER_INTERNAL_URL`). The issuer, the sign-in page and logout stay on the public origin, because only the browser uses them.
- **Sign-in is the provider's own page.** It offers email and password only. PKCE `S256` is required, codes are single-use and live 60 seconds, and five wrong passwords lock the account for 15 minutes. A provider session cookie per Project skips the form while it lasts. oauth2-proxy lets `/api/app-auth/` through without the platform's sign-in, and those routes read no forwarded identity.
- **Revocation needs no token store.** RS256 ID and access tokens last 5 minutes and are signed by one key, sealed at rest. Refresh tokens and sessions are JWTs that carry their issue time in milliseconds, and every refresh and session check re-reads the account. Disabling an account or changing its password moves its `tokens_valid_after`, so a signed-in visitor is out within one token lifetime.

## Considered options

- **Run Keycloak or Dex as the provider.** Rejected: standalone deployments ship no Keycloak, and another stateful service is more to operate than a few routes on the backend.
- **Hand the App a bearer token and a client SDK, as hosted App builders do.** Rejected: our Apps are arbitrary code, and the gate already enforces sign-in in front of every request. A token in the App would put enforcement inside code the agent writes.
- **Accounts per ProjectEnvironment.** Rejected: an owner would recreate every account after the first publish. **Accounts per Organization.** Rejected: one App's visitors could sign in to every other App of the Organization.
- **A built-in Sign-in provider.** Rejected: a Sign-in provider is one client for the whole Organization, with its session cookie on the shared apps domain ([ADR-0097](0097-sign-in-providers-use-the-oidc-plugins-own-callback-host-and-a-cookie-the-app-proxy-strips.md)), so one Project's App Users would be signed in to every App behind it. A client per environment keeps each session on its own App's host, as `manual` does.
- **Stored client secrets.** Rejected: a derived secret needs no row, no rotation and no copy outside the Middleware.
- **The gate calls the public origin.** Rejected: Traefik would hairpin through its own load balancer, and locally `*.localtest.me` resolves to loopback inside the cluster.
- **A refresh-token table.** Rejected: refresh tokens need revoking only per account, and `tokens_valid_after` does that without a write on every refresh.
- **A fixed role, `user` or `admin`.** Rejected: an App decides what its people may do, and one fixed pair cannot say "editor" or "billing". **Roles the App's code declares.** Rejected for now: the owner would have to ask the agent for every new role, and nothing would check that the code and the accounts agree anyway.
- **The owner sets every password.** Rejected: the owner would know each password and have to send it.
- **SMTP through a mail library.** Rejected: the platform already sends through Mailgun's HTTP API with `mailgun.js`, configured per environment by the deploy, and a second mail path would need its own credentials.

## Consequences

- A refresh token stays usable until it expires or its account is revoked, even after rotation hands out a newer one.
- Without `OIDC_PLUGIN_SECRET` or `OPSIFORCE_PUBLIC_URL`, saving `app_users` is refused.
- Without the Mailgun settings nothing is emailed: the owner copies every link, and a visitor who forgets their password asks the owner.
- App User email shares the platform's Mailgun account and sender; the `MAILGUN_*` keys stay when the External Services v1 cleanup removes `MAILGUN_RECEIVE_DOMAIN` and the webhook key.
- The signing key never rotates on its own. Each replica keeps it in memory, so rotating means deleting its row and restarting every replica, which signs out every visitor at their next refresh.
