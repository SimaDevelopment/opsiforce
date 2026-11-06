---
kind: explanation
terms: [Sign-in provider]
adrs: [0097]
---

# Sign-in provider

> How does an Organization admin register an identity provider once, so its Apps sign members in without project owners handling secrets?

## How it works

### Registering a provider

- Settings, Sign-in providers lists the [Organization](../../GLOSSARY.md)'s [Sign-in providers](../../GLOSSARY.md) and adds, edits and deletes them. The section and every route behind it except the list of names need `can_manage_tenant_sign_in_providers` ([Permissions](permissions.md)).
- A provider holds a name unique in the Organization, the issuer or discovery URL (`/.well-known/openid-configuration` is appended when missing), the client ID and the scopes, which must include `openid`. Its client secret is sealed with the platform's secret key and never returned by any route.
- An optional required claim names an ID-token claim, such as `groups`, `cognito:groups`, `realm_access.roles` or `https://example.com/roles`, with the values any one of which lets a visitor in, or none, meaning the claim only has to exist. Without one, everyone the identity provider signs in gets through, and the dialog warns about it.
- An optional groups claim, written the same way, names the claim whose values every App receives as the visitor's groups, for permissions inside the App.
- A claim name with a `:` or `/`, such as `cognito:groups` or `https://example.com/roles`, is one claim. Any other name is a dotted path through nested claims, so `resource_access.example-org-apps.roles` reaches a Keycloak client's roles.
- The identity provider's client must accept the secret in the token request body (`client_secret_post`). Microsoft Entra ID needs its directory-specific issuer, not `/common`, and its `roles` claim is safer to require than `groups`, which Entra drops for members of many groups.
- Each provider has one redirect URI to register with the identity provider, both as an allowed redirect URI and as an allowed post-logout redirect URI, `https://auth.<apps domain>/p/<provider id>/oidc/callback`, shown on its row and in its dialog once added. It never changes, whatever [Apps](../../GLOSSARY.md) use the provider ([ADR-0097](../adr/0097-sign-in-providers-use-the-oidc-plugins-own-callback-host-and-a-cookie-the-app-proxy-strips.md)), and a [Custom domain](../../GLOSSARY.md)'s own callback is registered beside it (below).
- Saving a provider also writes its callback route on the sign-in host `auth.<apps domain>`, and deleting removes it. The callback only completes the sign-in; the required claim is checked by each App, so a refused visitor gets 403 on the App's own address, where its Logout button works.

### Signing a visitor in

- In an environment's [App Auth](../../GLOSSARY.md) dialog, Sign-in provider is one of the [Auth modes](../../GLOSSARY.md). Each of the Organization's providers is its own Access option, between Public and Manual, shown by name. Choosing one needs only `can_manage_project_auth_settings` ([Environments](../projects/environments.md)).
- The environment gets the same Traefik OIDC plugin middleware as `manual`, filled from the provider. The plugin sends visitors to the provider's callback, checks the required claim on every request, and passes the App `X-Oidc-Subject`, `X-Oidc-Email` (or the username when the token has no email), `X-Oidc-Username`, and `X-Oidc-Groups`, the groups claim's values as a JSON array (a single value becomes a one-item array, and a missing claim or no groups claim gives `[]`). The plugin writes all four on every signed-in request, so a visitor cannot supply their own.
- The session is one cookie per provider on the apps domain, so signing in to one App signs the visitor in to every App that uses the provider. The App proxy removes these cookies from every request and drops any an App tries to set, so no App code sees or replaces them ([ADR-0097](../adr/0097-sign-in-providers-use-the-oidc-plugins-own-callback-host-and-a-cookie-the-app-proxy-strips.md)).
- A Custom domain signs visitors in on its own host, with a copy of the environment's middleware whose callback the identity provider's admin registers as one more redirect URI ([Domain routing](../projects/domain-routing.md)).
- Bypass paths and [Token forwarding](../../GLOSSARY.md) are set per environment, as for `manual`, and the two cannot be combined ([Token forwarding](../projects/token-forwarding.md)).

### Changing and deleting

- Saving a provider rewrites the middleware of every environment that uses it, and its Custom domains' copy, so a new secret or a changed rule applies to them at once ([ADR-0097](../adr/0097-sign-in-providers-use-the-oidc-plugins-own-callback-host-and-a-cookie-the-app-proxy-strips.md)).
- A provider still used by any [ProjectEnvironment](../../GLOSSARY.md) cannot be deleted. Switching those environments to another Auth mode releases it.
- The first publish and a [Duplicate](../../GLOSSARY.md) clone the source environment's middleware and keep its provider ([ADR-0007](../adr/0007-per-environment-app-auth.md)).

## Edge cases

- When an Organization has no Sign-in provider, the App Auth dialog says an admin adds one under Settings, and the mode cannot be saved.
- When a provider id belongs to another Organization, choosing or editing it answers not found.
- When the identity provider doesn't allow the provider's redirect URI, every App using it fails with the identity provider's redirect URI error until its admin adds it.
- When a visitor signs out of one App, they are signed out of every App that uses the same provider.
- When the identity provider doesn't allow the redirect URI as a post-logout redirect URI, signing out stops at the identity provider's redirect URI error.
- When the identity provider publishes no end-session endpoint, as Google does, the App's `/logout` does not sign the visitor out.
- When a script on another origin, such as another App, sends a credentialed request to a signed-in App, the answer carries no CORS permission, so the script cannot read it. A WebSocket it opens to a signed-in App is refused before reaching the App, since browsers apply no CORS to an upgrade.
- When an [Agent Caller](../../GLOSSARY.md) calls a Sign-in provider route, it is refused.
- When a client ID or client secret is written whole as `${NAME}` or `${file:/path}`, saving is refused ([Environments](../projects/environments.md)).
- When a group or role carries an apostrophe, `X-Oidc-Groups` writes it as `\'`, which a strict JSON parser rejects; the plugin's escaping does this.
- When the required claim or the groups claim names groups or roles, the identity provider must put them in the ID token, which most do only once that is turned on for the app: Keycloak needs an ID-token role mapper (its built-in role mappers write to the access token only), Microsoft Entra ID a groups claim or app roles, and Okta a groups claim. Until then every visitor is refused.

## Code

- `backend/src/sign-in-provider/` — the provider rows, input rules, sealing, and rewriting the environments that use a provider.
- `applyProvider` in `backend/src/project/project-auth.service.ts` — each environment's plugin middleware.
- `applySignInHost` in `backend/src/project/project-auth.service.ts` — each provider's callback route on the sign-in host.
- `stripPlatformCookies` and `dropPlatformSetCookies` in `proxy/internal/server/platform_cookies.go` — keep the sign-in cookie away from App code.
- `signedInFromAnotherOrigin` in `proxy/internal/server/forwarding.go` — no credentialed CORS for a signed-in request from another origin.
- `frontend/src/pages/sign-in-providers/` — the Settings section and its dialog.
- `frontend/src/components/project-auth/` — the Sign-in provider choice in App Auth.

## Related

- [Environments](../projects/environments.md) — App Auth per environment and how publish seeds it.
- [Token forwarding](../projects/token-forwarding.md) — what an App receives with the visitor's access token.
- [Permissions](permissions.md) — who may register providers and who may choose them.
- [Settings](settings.md) — the section's place in the Settings sidebar list.
