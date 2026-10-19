---
kind: explanation
terms: [Service skill]
adrs: [0082]
---

# Service skill

> How does an External Service's skill get into the Store, and how does it reach an Agent's Projects or one Project?

## How it works

### The skill

- A [Service skill](../../GLOSSARY.md) is a [Skill](../../GLOSSARY.md) in the Store named `service-<slug>`, marked by its service (`skills.external_service_id`, one per service, deleted with it): built-in for a Built-in External Service, the Organization's for a custom one, authored by no person ([ADR-0082](../adr/0082-an-external-service-declares-the-routes-it-serves-in-its-own-code-and-agents-learn-it-from-an-authored-skill-and-the-service-itself.md)).
- Its content is the `SKILL.md` in the service's folder with its `name` forced to `service-<slug>` and a generated footer; a service without one gets a minimal skill from its `displayName` and `description`. Its footer, "Reaching it", names only its [Service host](../../GLOSSARY.md) `https://<slug>.$EXTERNAL_SERVICES_HOST` and `/.well-known/opsiforce` there, which the service answers live with its routes and the caller's Project configuration ([ADR-0082](../adr/0082-an-external-service-declares-the-routes-it-serves-in-its-own-code-and-agents-learn-it-from-an-authored-skill-and-the-service-itself.md)).
- A service's routes are served live at `/.well-known/opsiforce`, so its Service skill never lists them and holds what nothing live says: what the service is for, how to set up each client it serves (curl, the upstream's CLI or SDK, a protocol client, App code) so it sends the key on the first request and never stops at a prompt, the upstream API with its version and docs link, how calling it here differs (filtered lists, narrowed searches, access levels, enforced conventions), conventions, each Event type's `data` keys, the shapes of any endpoint the service answers itself, and where the upstream keeps its own record of what was done. The External Service Builder writes it to that rule (`external-service-authoring` → `references/service-skill.md`) and shows the person its full text at the hand-over.
- A new version is laid only when that document changes: at boot for a built-in, and for a custom service whenever the files of its Default environment's `app/` change, on a Publish or in place, noticed when the backend next reads them ([External Service Builder](external-service-builder.md)). Every Agent Profile carrying it moves to the new version, and its Projects get it at the next fan-out.
- While its service is not Available, the Store marks it "Service unavailable" and the Agent page's skill picker leaves it out.
- It is read-only: the Store, the skill builder and the Public API answer `403 service_skill_read_only` to a new version, an import, a rename, Make public, Disable or Delete. The Store refuses any other Skill named `service-*`, and a Store Skill that already had such a name is renamed `store-<name>` at boot ([Skill](../agent-system/skills.md)).
- How to reach any service on its Service host, reading `/.well-known/opsiforce` and relaying a refusal live once in the [Platform Skill](../agent-system/platform-skill.md)'s External Services section.

### Who gets it

- An Agent carries a Service skill like any other Skill, added on the Agent page's Skills with the usual picker (refused with `409 service_unavailable` while its service is not Available), where it shows a Service mark; it always pins the latest version. No Agent starts with one: `agents.json` lists no Skills. A Skill & Agent Builder chat gets `service-public-api` because the chat is created with a `public-api` Project configuration ([Public API built-in](public-api.md)).
- A ProjectEnvironment gets the Service skill of every service it has a Project configuration for, whatever its Agent carries; enabling a service from the chat bar creates that configuration ([Configuration](configuration.md)). A builder chat's Test Project gets the service under test this way, with Development's `SKILL.md`: its configuration is created with the Test Project, or by Update (Test Project) once Development can be served, and Update delivers the skill again.
- A Custom Agent may hold [Service settings (Agent)](../../GLOSSARY.md) on each Service skill it carries: the Agent page's Skills offers **Service settings** on its row, with the service's Project form without its targets (fields whose options come from a call, secrets, generated and unique fields), and shows what new Projects start with. Every Project of the Agent created afterwards starts with a Project configuration written from them, so its Service skill arrives with the Project rather than on a first save; removing the Service skill removes its settings, and a Built-in Agent has none ([Configuration](configuration.md), [ADR-0089](../adr/0089-a-custom-agents-service-settings-seed-a-real-project-configuration-in-every-new-project.md)).
- A ProjectEnvironment's Service skills are therefore its Agent's plus those of its configured services, while each service is [Available](../../GLOSSARY.md), minus what it switched off ([Switch off (Skill)](../agent-system/switch-off-skill.md)). The service reads only the Project configuration.

### Reaching Projects

- Service skills reach the running Projects of every Agent origin, the one exception to a Custom Agent's snapshot at create besides switching a Skill back on ([Dynamic Delivery](../agent-system/dynamic-delivery.md)). Adding or removing one on an Agent, a new version, a first save that enables a service in a ProjectEnvironment, a Disconnect that removes it there, a service becoming or ceasing to be Available, and a Disable, Enable or Delete of a custom service each fan out to the Projects concerned; a boot pass redelivers any environment left behind.

## Edge cases

- When a service stops being Available, its skill leaves every Project at the next fan-out, and its stored Project configurations stay.
- When a Custom Agent's Profile is published, its Service skills are copied with its other Skills.
- When a custom service's builder chat is deleted, by Delete or as a Project, its Service skill leaves every Agent in the same transaction.

## Code

- `backend/src/external-services/knowledge/` — laying versions, which Service skills an environment gets, and the fan-out.
- `backend/src/delivery/service-skill-source.ts` — where delivery reads which Service skills a workspace should have.
- `backend/src/builder/builder-chat.service.ts` — the `public-api` Project configuration a new Skill & Agent Builder chat starts with.

## Related

- [Dynamic Delivery](../agent-system/dynamic-delivery.md) — the writer and fan-out that lay every skill.
- [Switch off (Skill)](../agent-system/switch-off-skill.md) — narrowing one ProjectEnvironment.
- [Platform Skill](../agent-system/platform-skill.md) — the External Services section every Service skill points to.
- [Custom Agents](../agent-system/custom-agents.md) — Profiles per Environment and Publish (Agent).
