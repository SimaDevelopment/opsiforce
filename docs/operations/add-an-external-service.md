---
kind: operations
---

# Add an external service

> Ship a new Built-in External Service: one folder with its Service manifest, `service.ts` and Service skill, and one commit.

A [Built-in External Service](../../GLOSSARY.md) is a folder under `packages/opsiforce/external-services/<slug>/` that the backend loads at boot and serves in process behind the built-ins adapter; the platform supplies the Service host, the Gate, both Forms, the Events store, the doorbell and the Call log and Usage tables, so nothing outside the folder changes ([Service manifest](../external-services/service-manifest.md)). A [Custom External Service](../../GLOSSARY.md) built in an [External Service Builder](../../GLOSSARY.md) chat becomes one the same way, by committing its folder here.

## Prerequisites

- The outside system's semantics: how it authenticates, which of its requests an Agent or App should be able to send and what each Project's settings allow, and, for anything inbound, how its webhook is signed and what identifies whom a delivery is for.
- A slug that matches `^[a-z][a-z0-9-]{1,30}$` and is not one of the reserved `usage`, `webhooks`, `agent`, `admin` or `services`.

## Steps

Run the `external-service-cli` commands from `packages/opsiforce/external-services/` as `yarn external-service-cli …`.

1. Write `<slug>/service.json` with `"sdk": 2`: the Service form (vendor settings and secrets, filled once by the platform operator), the Project form (what each ProjectEnvironment may reach) and, with `"inbound": true`, the [Event](../../GLOSSARY.md) types with a title and description each. Check it with `external-service-cli check <slug>` until it reports no errors.
2. Generate `<slug>/service.types.ts` with `external-service-cli types <slug>`; run it again after every change to `service.json`.
3. Write `<slug>/service.ts`, whose default export is `defineService<Manifest>({ manifest, routes, … })`: the routes with their checks, the form handlers and hooks the manifest names and, for anything inbound, the `webhook` handler that verifies a delivery and calls `deliver()` ([Service manifest](../external-services/service-manifest.md)). Keep the code in `<slug>/src/`.
4. Write `<slug>/SKILL.md`, the [Service skill](../../GLOSSARY.md) the backend lays as a Skill in the Store at boot, and add `icon.svg` if the manifest names one.
5. Write tests under `<slug>/test/`, mirroring `src/`, with `testService` from `@opsiforce/external-service-sdk/testing` and run them with `yarn test` in `packages/opsiforce/external-services/`.
6. Commit the folder. Agents get its Service skill when an editor adds it on the Agent page, and a Project when someone enables the service in its chat bar.

## Verify

- The backend boots; a folder that fails its check, or whose `service.ts` defines another manifest, stops the boot and names the problem.
- Store → External Services shows the service to the platform operator, and it turns [Available](../../GLOSSARY.md) once its Service configuration is saved complete.
- A request from a configured ProjectEnvironment's pod to `https://<slug>.$EXTERNAL_SERVICES_HOST` answers as its routes say and appears in that Project's Calls; a test delivery to `/api/external-services/webhooks/<slug>` stores an Event in the receiving environment's `external-services.db`, visible in Datasette and counted on the service page's Usage tab.
