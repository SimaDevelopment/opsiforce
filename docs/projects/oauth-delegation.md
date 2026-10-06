# Forward OAuth access tokens to generated apps

Manual App Auth has an opt-in **Forward the signed-in user's access token** checkbox. The pinned Traefik OIDC plugin already supports access-token templates; no plugin fork is required. Select the intended API scopes and register every callback shown in the form.

The app backend receives `X-Opsiforce-Access-Token` for the current visitor. Entra also supplies `X-Opsiforce-Tenant-Id` and `X-Opsiforce-User-Id` from the validated ID token. Use the access token only server-side for the intended API. Never return or store it in the frontend. Each user signs in independently; do not use an app owner's token as a fallback.

Deploy the backend, frontend and Go runtime proxies together. Backend and proxies must share a random, secret `APP_AUTH_FORWARDING_SIGNING_KEY` of at least 32 characters (deployments read it from the `OPSIFORCE_APP_AUTH_FORWARDING_SIGNING_KEY` GitHub secret); without it, saving auth with forwarding is refused. The key is used only for token forwarding, never sent over the network, and is independent of `PROXY_CONTROL_TOKEN`. Saving auth generates a domain-separated, per-environment HMAC transport credential that the runtime checks and removes before forwarding. Cloning auth regenerates it for the destination environment. After rotating `APP_AUTH_FORWARDING_SIGNING_KEY`, re-save affected App Auth configurations to regenerate their credentials.

The transport credential is a bearer credential between trusted services, not a signature over the request. Keep the ingress-to-runtime path private or encrypted, restrict direct pod access and middleware inspection, and ensure intermediary access logs do not capture request headers. Generated apps are trusted with their users' access tokens; review app code accordingly. Do not expose pod ports directly. This feature does not authorize arbitrary app endpoints by itself.

Forwarding is disabled by default and cannot be combined with authentication bypass paths. Requests without a valid per-environment transport credential lose all reserved `X-Opsiforce-*` headers; other runtime surfaces strip them as well. Preview does not perform App Auth and should display a disconnected state. Apps must require delegated context for their API routes and must not trust the older generic identity headers alone.

Delegated app requests are excluded from runtime request logging, including bodies. Reserved headers are redacted in diagnostics and removed from response headers. The browser should call same-origin backend routes; use per-user storage keys and `Cache-Control: no-store` for personal data.

For read-only OneDrive use `openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Files.Read`. Keep ID-token issuer/audience validation enabled. The backend can check `/v1.0/me`, then call `/v1.0/me/drive/root/children` with `Authorization: Bearer <token>`. Consent and a provisioned OneDrive are required. Refresh is handled by the OIDC plugin; reauthenticate if it fails.

Existing environments need their own updated App Auth settings. Publishing alone does not overwrite their authentication. End-to-end Entra login and refresh should be tested on the deployed authenticated hostname with two separate user sessions.
