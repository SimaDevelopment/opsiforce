# Sign-in providers use the OIDC plugin's own callback host and a cookie the App proxy strips

An Organization admin wants every App the Organization builds to sign its members in through the Organization's own identity provider, such as Microsoft Entra ID, Google Workspace, Okta or Keycloak, without each project owner entering a client ID and secret they do not have. App Auth already signs visitors in with the `traefik-oidc-auth` plugin, one middleware per environment, for `manual`. With the plugin's default relative callback, every App host is one more redirect URI to register, and Entra ID and Google refuse wildcard ones.

**A [Sign-in provider](../../GLOSSARY.md) is a row owned by one Organization, with its client secret sealed. An environment in Auth mode `provider` gets the same per-environment plugin middleware as `manual`, filled from that row and set to the plugin's absolute-callback mode. On the apps domain, each provider has one redirect URI, `https://auth.<apps domain>/p/<provider id>/oidc/callback`, and one session cookie, which the App proxy removes before any App code sees it.** Concretely:

- **It is the plugin middleware `manual` writes,** filled from a row the Organization owns instead of from values each owner types. It reads claims from the ID token, the one token every provider issues to the app in a form it can verify.
- **One redirect URI per provider.** Every middleware of the provider sends visitors to the same callback. One more copy of the middleware serves it on the sign-in host `auth.<apps domain>`, under the provider's own path, so a new App needs nothing at the identity provider. A [Custom domain](../../GLOSSARY.md) is the exception: its App's domains get a copy of the environment's middleware with the relative callback, so the App's Main domain completes sign-in on itself at `https://<domain>/oidc/callback`, one more redirect URI the identity provider's admin registers ([ADR-0105](0105-each-custom-domain-gets-its-own-route-carrying-its-apps-gate-or-the-unprotected-marker-and-signs-in-on-its-own-host.md)).
- **One session per provider.** The plugin writes its session cookie, named with the prefix `_opsiforce_sp_<provider id>`, on the apps domain, so every App using the provider reads the same session. Signing in to one App signs the visitor in to all of them, and signing out of one ends all. A Custom domain is the exception: its copy of the middleware writes the cookie, with the same prefix, for that host alone, so the visitor signs in there once more.
- **The cookie never reaches App code.** The plugin removes its own cookies before forwarding a request. The App proxy removes every `_opsiforce_sp_` cookie from every request it serves, on the apps domain and on Custom domains alike, including requests to Apps that use another provider or none.
- **No App can read another App as the visitor.** A request the plugin signed in that comes from another origin gets no credentialed CORS headers, neither the App proxy's nor the App's own, and its WebSocket upgrade is refused, and the App proxy drops any `Set-Cookie` an App sends with the platform prefix.
- **The required claim is the plugin's `AssertClaims`, checked on every request by each App's middleware.** A changed rule applies to visitors who are already signed in. The sign-in host's copy has no rule: it only completes the sign-in, so a refused visitor's 403, and its Logout button, are on the App's own host.
- **The row is the source and every middleware is a copy.** Saving a provider rewrites its sign-in host middleware and the middleware of every environment that uses it.
- **Apps receive identity and groups as headers, the same for every provider:** `X-Oidc-Subject`, `X-Oidc-Email`, `X-Oidc-Username`, and `X-Oidc-Groups`, the values of the claim the provider names as its groups claim as a JSON array, like oauth2-proxy's groups claim. A header whose claim the identity provider doesn't send is empty, or `[]` for groups. Tokens reach the App only through opt-in Token forwarding.
- **Bypass paths and Token forwarding stay per environment,** inside its middleware, as for `manual`.
- **An external identity provider is never an Auth mode of its own.** An Organization that wants to sign visitors in through one adds it as a Sign-in provider. The one platform-operated provider an environment can choose is App Users (`app_users`), whose accounts belong to the Project and which the backend runs itself ([ADR-0099](0099-app-users-sign-in-through-an-oidc-provider-the-backend-runs-with-one-client-per-projectenvironment.md)).

## Considered options

- **Keycloak-shaped role headers (`X-Oidc-Realm-Roles`, `X-Oidc-Client-Roles`).** Rejected: they fit one provider and no App read them, and they came from the retired `managed` mode.
- **Forwarding the ID token so each App reads any claim.** Not built: it hands App code a signed credential by default, where a named groups claim covers permissions.
- **The plugin's default relative callback on every App host.** Rejected: with Entra ID or Google, the identity provider's admin would add each new App's callback URLs before sign-in works there.
- **A broker host handing each App a one-time ticket.** It gives the same single redirect URI with a separate session per App host. Rejected: it needs a session store, a ticket hand-off, a `forwardAuth` gate and App-proxy changes of our own, about a thousand lines, where the plugin already supports one callback host.
- **Writing redirect URIs into the identity provider through its admin API.** Rejected: per-vendor code and a highly privileged credential per Organization.
- **The platform as its own OIDC provider in front of the customer's.** Rejected: two token layers and signing keys.
- **A built-in, platform-operated row in the table.** Rejected: its client is operator configuration, and it checks a role computed per Organization.

## Consequences

- Browsers send a provider's session cookie to every host under the apps domain. That is safe only while the App proxy serves every one of them, as it does for Apps and their previews today. A new service under the apps domain must strip the cookie too.
- The apps domain cannot be listed on the Public Suffix List, because that would stop browsers storing the shared cookie.
- The `auth` host label under the apps domain is reserved for the sign-in host. No App host may use it.
- Every signed-in App, `manual` ones included, stops answering credentialed requests from other origins, including other Apps.
- A script on any App can still plant a cookie with the provider's name on the apps domain, signing a visitor in as the script owner's own account there. A required claim narrows who that can be.
- The client secret is sealed in the row and copied, unsealed, into each middleware spec, as `manual`'s is.
- The plugin sends the client secret in the token request body (`client_secret_post`), so the identity provider's client must accept that. Okta's web apps default to `client_secret_basic`.
- The plugin checks claims in the ID token. A Keycloak client needs a realm-roles mapper that also writes to the ID token before `realm_access.roles` can be required.
- A provider still used by an environment cannot be deleted.
- A save that fails to rewrite some environments still keeps the row, and answers with how many environments kept the previous settings, so the admin saves again.
