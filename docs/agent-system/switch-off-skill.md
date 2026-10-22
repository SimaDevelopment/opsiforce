---
kind: explanation
terms: [Switch off (Skill)]
adrs: [0085]
---

# Switch off (Skill)

> How does one Project's environment stop its agent seeing a Skill the Agent carries, and how does the chat bar show which Skills are on?

## How it works

- A ProjectEnvironment can [Switch off (Skill)](../../GLOSSARY.md) any Skill it has except `platform`: a pinned Store Skill, one its Agent's package ships, or a [Service skill](../external-services/service-skill.md), whether its Agent carries it or the service is configured here ([ADR-0085](../adr/0085-a-project-environment-switches-skills-off-by-a-stored-choice-and-the-chat-bar-derives-the-rest.md)). Only the choice is stored, one `project_environment_skills_off` row per Skill name; no row means on, so new Projects and Skills newly added to the Agent start on, and a row outlives the Skill leaving the Agent.
- Every writer honours the rows. Delivery at create (and a Test Project's Reset) leaves switched-off names out; the fan-out drops them from what it wants and removes any switched-off name still on disk, whoever wrote it, through the usual notice and confirmation; the [Agent Updates](agent-updates.md) Job is handed the names in `SWITCHED_OFF_SKILLS` and neither writes nor owns them ([Dynamic Delivery](dynamic-delivery.md)).
- Switching back on lays the Version the Agent carries now: a Built-in Agent's Store Skill and a Service skill through the fan-out; a package's Skill (from the backend's copy of `agent-config`, left out of the delivery rows so the Job takes it back) and a Custom Agent's Store Skill (from the Profile its behaviour is read from, moving that one Skill past the Project's snapshot) written at once and confirmed.
- `/api/projects/<projectId>/environments/<projectEnvironmentId>/skills` serves the chat bar's Skills popover, before the External services button: `GET` (anyone who can open the Project) lists the Agent's Skills plus any still on disk, each `on`, `switched-off`, `switching-on` (wanted but not on disk yet), `retrying` (named by a failed delivery) or `always-on` (`platform`), with `carried: false` for one the Agent dropped.
- `PUT <skillName> {on}` switches one Skill: a Service skill needs `can_configure_project_external_services`, any other `can_manage_project_skills` ([Permissions](../organization/permissions.md)). Builder chats show no Skills popover.
- Switching off changes what the agent knows, never what it may do: the Gate never reads the rows, and a Service skill switched off leaves its Project configuration as it was.
- A [Publish](../projects/publish.md) replaces the target's rows with Development's and fans the change out, with a `skills-off` line in its report naming what was newly switched off or back on.

## Edge cases

- When a Skill the Agent no longer carries is switched off, it cannot come back there.
- When someone switches a Skill back on during a running Agent Update, the switch answers `409`.
- When someone tries to switch off `platform`, the switch answers `409`.
- When a conversation already loaded a Skill, it keeps that text after the switch; the change applies from the agent's next look at its Skills.

## Code

- `backend/src/delivery/environment-skills.ts` — the popover's derived list and the switch.
- `backend/src/delivery/skill-switch.repository.ts` — the stored switched-off rows.
- `backend/src/project-skills/` — the chat bar's Skills routes.
- `agent-config/scripts/agent-workspace-migrate.mjs` — the Agent Updates script that skips `SWITCHED_OFF_SKILLS`.
- `frontend/src/components/project/skills/skills-button.tsx` — the Skills popover.

## Related

- [Dynamic Delivery](dynamic-delivery.md) — the writers the rows constrain.
- [Agent Updates](agent-updates.md) — the image Job that skips switched-off names.
- [Skill](skills.md) — what is being switched, and Disable (Skill), which is Organization-wide.
- [Service skill](../external-services/service-skill.md) — the Service skills a configurer may switch.
- [Publish](../projects/publish.md) — carrying Development's choices.
