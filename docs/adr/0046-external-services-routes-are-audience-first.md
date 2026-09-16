# External-services routes are audience-first

Every inbound external-services endpoint lives under `/api/external-services/`, and the first segment after the prefix names the audience (`webhooks`, `agent`, `admin`), not the service, so authentication is a property of the mount: webhooks authenticate by the definition's own verify step, `agent` by the Service Gateway token, `admin` by an operator session plus one permission. Two thin dispatch controllers declare their guard once at the class and hand the remaining path to the addressed service definition's route table, so a definition can never pick a mount or a guard and the worst a buggy route table can do is expose that service's own data to an already-authenticated audience. The names `usage`, `webhooks`, `agent`, `admin` and `services` are reserved, and the registry refuses at startup to register a definition that takes one.

## Considered options

- **Service-first routes** (`/api/external-services/<service>/webhooks`). Rejected: each service would carry its own guards, and a misconfiguration would be per service rather than impossible.
- **A dynamic Nest module per service.** Rejected: it hands each definition its own paths and guards and buys nothing, since validation here lives in services as plain TypeScript.

## Consequences

- Adding a service is one definition file and one line in the definitions barrel; no controller, guard or permission is added.
- Tenant checks are derived from route shape: a route that names an environment is checked against the caller's tenant by the dispatcher, a route that names none reaches the platform-wide resource registry.
