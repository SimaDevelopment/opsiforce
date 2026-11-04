---
kind: explanation
terms: [Public URL, App Slug, App Short ID, Edit URL]
adrs: [0012]
---

# Public URL

> Which address does each App answer on, how is it chosen and changed, and which older addresses keep serving?

## How it works

### Addresses

- An App's [Public URL](../../GLOSSARY.md) is `{App Slug}-{Environment Slug}-{App Short ID}` under the apps domain, e.g. `equipment-monitor-dev-6713b7a51450.apps…` for the environment `6713b7a5-1450-45f0-8fd0-321f11bf22e2` ([ADR-0012](../adr/0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)). The [App Short ID](../../GLOSSARY.md) alone picks the environment and the [Environment Slug](../../GLOSSARY.md) only names it; a database trigger gives every [ProjectEnvironment](../../GLOSSARY.md) its App Short ID on insert: the first 12 hex characters of its id without dashes, extended two characters at a time while that prefix is taken.
- An App with no App Slug answers on the legacy `{environmentId}-{Environment Slug}` host, or the bare `{environmentId}` host for a warm-pool row with no Environment yet. Both legacy hosts keep serving forever, with no redirect.

### Resolving a host

- The app proxy hands the backend the full host a visitor opened, and the backend answers serve, redirect or 404 ([Request Flows](../runtime/request-flows.md)). Only one label of lowercase letters, digits and inner dashes, at most 63 characters, directly under the apps domain and with no trailing dot, resolves; any other host, a host with no environment behind it, or a warm-pool row not yet claimed answers 404.
- A label that is an environment id alone or followed by a dash names that environment when it exists: it serves as the id alone or followed by `-{its Environment Slug}`, and redirects to the environment's canonical host for any other suffix. Otherwise the hex text after the last dash is an App Short ID: the canonical label serves, and any other label ending in it redirects.
- A redirect answers `environmentId`, `canonicalHost` and `protected` without waking the pod and becomes a 308 that keeps path and query and that browsers never store, unless the app proxy refuses a protected App reached through the catch-all apps route ([Environments](environments.md)). Only a serve runs the ensure gate and answers the upstream.
- The in-product App preview's `{environmentId}` host on the preview apps domain serves that environment by id and never redirects. The backend's `PREVIEW_APPS_HOSTNAME` names that domain, `preview.{apps domain}` by default, and matches the frontend's `VITE_WEBAPP_PREVIEW_DOMAIN` and the proxy chart's `appProxy.previewAppsHostname`.

### App Slug

- The [App Slug](../../GLOSSARY.md) is set at the App's first [Go-live](../../GLOSSARY.md) from its name: transliterated (`Облік обладнання` → `oblik-obladnannya`), every other character run turned into one `-`, cut to fit the 63-character label, and `app` when nothing readable is left or the result starts with a uuid. Renames never change it and only [Edit URL](../../GLOSSARY.md) does.
- A copy starts from the App Slug of the App it copies, or from its own name when that has none, cut again to fit its own label: a published environment's App at its first go-live from Development's, a [Duplicate](../../GLOSSARY.md)'s Development from the source's ([Duplication](duplication.md)), and an imported App from the one its export carries ([Export and Import](export-import.md)).
- At every backend start, each App without an App Slug gets one from its current name, so an App that went live before App Slugs takes its readable address at the first start after the upgrade ([ADR-0012](../adr/0012-a-public-url-reads-as-app-slug-environment-slug-and-app-short-id-and-old-hosts-keep-serving.md)). The pass runs beside start-up without delaying it and writes only where the App Slug is still empty, so replicas starting together give each App one, and one an older replica created during a rollout gets it at the next start.
- An App whose sign-in callbacks are registered with an identity provider outside the platform (manual [App Auth](../../GLOSSARY.md)), a Duplicate of one included, gets no App Slug at go-live or from that pass and keeps the legacy host, as does a Project that serves an [External Service](../../GLOSSARY.md). Every App left without one, except an External Service's, is offered one: the environment list carries a `suggestedAppSlug` from its current name, the Edit URL dialog starts from it, and the App pane shows the readable address it gives with a Switch action that opens the dialog.

### Edit URL

- Edit URL sets one environment's App Slug: a control next to Copy URL in the Environments switcher row and a pencil beside Copy URL and Open app in the App pane's header, backed by `PATCH /api/projects/<id>/app` with `{ environmentId, appSlug }` and gated by `can_edit_app_details`. The App Slug is taken as typed, never slugified: lowercase letters, digits and inner dashes but not as the 3rd and 4th characters (reserved for punycode), at most 63 − (Environment Slug + 1) − (App Short ID + 1) characters, and not starting with a uuid, with the backend naming the broken rule in plain words.
- App Slugs are not unique, and Edit URL is refused before go-live and for a Project that serves an External Service. Its dialog previews the new address under the input with the typed part highlighted, names the current one once it differs, shows the backend's refusal in place of the preview and, on a manual App Auth environment, names the new address's sign-in callback to register with the identity provider before saving.
- Every earlier readable address then redirects to the new one while both legacy hosts keep serving, and App Auth already covers them all ([Environments](environments.md)).

### Handing it out

- The platform hands the Public URL out as `publicUrl` on the project environment list and on publish jobs, `null` until the App first goes live, and Copy URL, Open app, the Environments switcher and the publish job's "Open app" link show it. A pod gets its address as `APP_PUBLIC_URL` at start, live or not, and a warm-pool pod, started before it has an Environment, gets the bare host.
- The link the agent shares comes from `app-url` instead, which asks the backend for the current Public URL ([App Readiness](app-readiness.md)), and the Public API returns it as `publicUrl` ([Public API contract](../public-api/contract.md)).
- A Project that serves an External Service has no Public URL: `publicUrl` is `null`, every host of its environments answers 404 on either ensure route, its pod gets no `APP_PUBLIC_URL`, and no Copy URL, Open app or Edit URL is shown.

## Edge cases

- When a pod started before an Edit URL, its `APP_PUBLIC_URL` keeps the older address, which now redirects unless it is a legacy host, until the pod restarts.
- When a webhook sender or API client calls an earlier readable address, it gets the redirect, which most such clients don't follow, so they must be pointed at the new address.
- When a renamed App keeps its App Slug, its Public URL no longer matches its name until someone uses Edit URL.

## Code

- `backend/src/common/app-host.ts` — the canonical and legacy hosts of a ProjectEnvironment.
- `backend/src/common/app-slug.ts` — deriving an App Slug from a name and naming the rule an edited one breaks.
- `backend/src/project/app-slug-backfill.ts` — the start-up pass that gives existing Apps an App Slug.
- `backend/src/project-environment/public-url.service.ts` — the Public URL the platform hands out, and a pod's `APP_PUBLIC_URL`.
- `backend/db/migrations/0086_app-short-ids.sql` — the trigger and SQL function that assign App Short IDs.
- `backend/src/proxy/app-address.ts` — resolving a host to an environment, and whether it serves or redirects.

## Related

- [Environments](environments.md) — the Environment Slug and the App Auth gate that covers every address.
- [Request Flows](../runtime/request-flows.md) — the app proxy and the ensure gate a served host runs.
- [App](app.md) — the App Details the App Slug is derived from.
- [App Readiness](app-readiness.md) — Go-live, which sets the App Slug, and `app-url`.
- [Public API contract](../public-api/contract.md) — `publicUrl` in the Public API.
