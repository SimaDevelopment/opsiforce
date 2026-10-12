# An External Service is a manifest and handlers behind routes the platform owns

An External Service speaks to an outside system with that system's credentials, and a Custom External Service is code an Organization wrote with an Agent. If each service declared its own HTTP routes and checked its own callers, one buggy service would expose its data to every caller that reached it, and nothing the platform shows or switches per Project would exist.

**An External Service is a folder: its Service manifest (`service.json`), its handlers written with the SDK and its Service skill. The platform owns every route, guard and check in front of it, and a handler only ever runs for a call the platform has already admitted.** Concretely:

- **Routes are audience-first and the platform's.** Everything lives under `/api/external-services/`, and the first segment names who calls: `webhooks/<service>` (the outside system; the service's `inbound` handler verifies it), `agent/<slug>` (a ProjectEnvironment's pod, authenticated by its `service` Gateway Key at the Gate), and the platform operator's, Organization admin's and Project member's surfaces behind a session and one permission. A service declares no path, guard or permission. The names `usage`, `webhooks`, `agent`, `admin` and `services` are reserved, and the backend refuses to boot on a Built-in External Service folder that takes one.
- **Everything checked is declared.** The manifest declares the Forms, each Operation's kind, input schema and bounds, and each Event type's data schema. The Gate refuses an Operation the Project configuration has off, input that does not fit or reaches past the bounds, before the handler runs; the inbound pipeline drops an Event that does not fit its schema and routes the rest by bounds ([ADR-0084](0084-the-platform-routes-incoming-events-by-the-same-bounds-as-operations-and-wakes-the-app-to-receive-them.md)).
- **One wire, two places.** The handlers answer the same `/_service/*` requests in process for a Built-in External Service and over HTTP in the service's own pod for a Custom one, and the Gate checks both answers the same way.
- **A Built-in External Service is a committed folder.** `packages/opsiforce/external-services/<slug>/` holds `service.json`, `handlers.ts`, the generated `service.types.ts`, `SKILL.md` and an optional icon. The backend loads every folder at boot with the same check as `external-service-cli check --built-in` and refuses to boot on one that fails. Adding a built-in is a folder and a commit: no controller, guard, permission, module line or migration.

## Considered options

- **Service-first routes** (`/api/external-services/<service>/webhooks`). Rejected: each service would carry its own guards, and a misconfiguration would be per service rather than impossible.
- **A dynamic Nest module per service.** Rejected: it hands each service its own paths and guards, and a Custom External Service cannot run inside the backend.

## Consequences

- What an Agent may call, what a Form shows and what may arrive are read from the manifest without running the service.
- A handler whose generated types were made from another manifest refuses to boot, so a manifest change without regenerated types never reaches callers.
- Tenant checks come from the caller's key and the Project configuration, never from route shape.
- The SDK carries a major version (`"sdk": 1` in the manifest); a Custom External Service keeps its own copy of it ([ADR-0081](0081-a-custom-external-service-carries-its-own-copy-of-the-sdk-and-upgrades-it-only-when-asked.md)).
