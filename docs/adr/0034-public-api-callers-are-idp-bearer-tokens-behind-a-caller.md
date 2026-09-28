# Public API callers authenticate with IdP bearer tokens through oauth2-proxy, modelled as a per-request Caller

The public API needs machine authentication, and the platform has no credential store of its own: identity comes from the deployment's IdP through oauth2-proxy, which accepts bearer JWTs (`--skip-jwt-bearer-tokens`) and forwards user, email and groups as headers on every backend request. Platform-issued API tokens would add a table, hashing, scopes, a UI and a freshness problem.

**A person or program calls `/api/v1/*` with an IdP-issued bearer token.** There is no new storage, and the headers are the same as on the browser path, so the caller holds exactly the Organization memberships and permissions they have in the UI. oauth2-proxy's `--api-route=^/api/(v1|proxy)/` makes a missing or expired token a 401 rather than a login redirect. The only unauthenticated `/api/v1` routes are the published documents (`openapi.json`, `runtime/openapi.json`, `docs`). A client discovers its IdP from deployment configuration. In standalone `static` mode the API is anonymous-admin, network-trusted like the rest of that mode.

Controllers never read those headers. `PublicApiGuard` builds a **`Caller`** per request, in memory, with a `source` discriminator: `idp-bearer` for a forwarded identity, and `gateway-key` for a pod's `gw-` bearer ([ADR-0062](0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)). The Caller carries the user (kind `user` or `service-account`, detected by Keycloak's fixed `service-account-` username prefix), the selected Organization, the caller's Organizations and their permission set. The guard resolves the platform user once with `getOrCreateUser`, so `Caller.user` carries both `id` (the IdP subject) and `platformId` (the id `/me` returns and every other route uses).

The whole contract names the Organization **tenant**, because it is read by programs, not people: the selecting header is the **existing `x-tenant-name`**, `/me` answers `tenant` and `tenants` as `TenantRef`s, the selection refusals are `tenant-required` and `tenant-forbidden`, and the reference text says tenant. Selection is implicit when the caller belongs to exactly one, a 400 listing the choices when several and none is named, and one indistinguishable 403 for a wrong or unknown name. The existing tenant and permission guards run unchanged; the public guard runs after them and adds, for `idp-bearer` callers, the entry permission `can_use_public_api` (admin bundle by default), the multi-Organization strictness, and the service-account rule: a service account gets no Personal workspace, and its Projects default to Public placement.

`can_use_public_api` gates the platform API only. Chat is native opencode reached through `/api/proxy/{environmentId}` ([ADR-0038](0038-chat-is-native-opencode-through-the-runtime-proxy.md)), gated by Organization membership and per-user Project visibility, identical for a browser and a program. A caller without `can_use_public_api` who can open the Project in the app can reach its runtime.

The tenant and permission guards raise `TenantAccessDeniedException` and `MissingPermissionException`, subclasses of `ForbiddenException` with the same status and message, so the public filter maps them to `tenant-forbidden` and `permission-denied` (naming the permission) without matching message text, and the internal API's wire shape is unchanged. `can_delete_project` gates Project delete on both the internal and the public route, so the two surfaces cannot drift.

## Considered options

- **Platform-issued API tokens.** Not built: storage, scopes and revocation are a full effort, and bearer auth covers the consumers there are.
- **Organization in the contract.** Rejected: a new `X-Organization` header, or `organization` fields and error types next to `x-tenant-name`, would be a second wire vocabulary for the one thing the UI already sends as tenant; the contract is wire vocabulary for technical readers, not user-facing copy.
- **Opting the public routes out of the global guards.** Rejected: duplicates tenant resolution for no gain; the public guard only tightens.
- **Naming the object `Principal`.** Rejected: framework jargon; `Caller` says what it is and covers every source.
- **No entry permission.** Rejected: adding one later breaks every token holder; starting with it and granting it to admins costs nothing.
- **Mirroring Makara's token relay.** Rejected: a different product's constraint, not ours.

## Consequences

- Every Keycloak client that issues tokens for the API needs an audience mapper; that is deployment configuration, not code.
- Service accounts become first-class users on their first request, without a Personal workspace.
- A new caller kind extends `source` and the guard; controllers stay untouched.
- Runtime access is environment-level: filesystem and shell operations, session mutation, model switching and integration or credential operations, not prompt-only access.
- A standalone deployment that wants an authenticated API runs `oidc` mode against its own IdP; there is no broker in standalone.
