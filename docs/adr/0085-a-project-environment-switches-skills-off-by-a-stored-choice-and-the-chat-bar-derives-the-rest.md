# A ProjectEnvironment switches Skills off by a stored choice, and the chat bar derives the rest

One Agent serves many Projects, and a Skill that is right for most of them misleads the agent in some: an agency's App Builder carries one brand Skill per client, and in one client's Project the agent loads the other client's brand. Without a per-Project choice, the only remedy is one Custom Agent per client.

**Each ProjectEnvironment can Switch off (Skill) any Skill it has except the Platform Skill. Only the choice is stored, as one row per switched-off Skill name; everything the chat bar shows is derived by comparing that choice with what the Agent carries, the delivery ledger and the workspace.** Concretely:

- **Storage:** `project_environment_skills_off (project_environment_id, skill_name, switched_off_by, switched_off_at)`, keyed by name because a package's Skills have no `skills` row and the folder name is a Skill's identity on disk. No row means switched on: new Projects start with everything, and a Skill added to the Agent arrives switched on. A row survives the Skill leaving the Agent, so a returning Skill stays off where someone switched it off.
- **Per ProjectEnvironment, carried by Publish:** Publish (App) replaces the target environment's rows with Development's, the same rule the chat bar's Project configurations follow.
- **Every writer honours the rows:** the Skill-delivery fan-out removes and never re-lays a switched-off Skill, and the Agent Updates Job is handed the list so it skips a package's Skills there. Removal and the reload confirmation are the existing delivery path ([ADR-0030](0030-agent-owned-file-changes-need-no-opencode-reload.md), [ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)).
- **Switching back on lays the Version the Agent carries now**, read from the Agent Profile delivery already reads. In a Custom Agent's Project this moves that one Skill forward and nothing else: an exception to [ADR-0058](0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)'s snapshot at create, for this act only.
- **The bar lists** the Agent's current Skills plus any Skill still present in the workspace, each as on, switched off, switching on, failed delivery, or always on (the Platform Skill). A Custom Agent's Skill the Agent no longer carries stays listed while present and drops out once switched off.
- **Permissions:** `can_manage_project_skills` switches Store and package Skills; `can_configure_project_external_services` switches Service skills, alongside the Project configuration it already edits. Which Agents carry a Service skill stays the Agent's Skills, and a configured service brings its skill to that ProjectEnvironment ([ADR-0082](0082-an-external-services-skill-is-a-skill-marked-by-its-service-given-per-agent-or-per-project-and-reads-its-operations-live.md)).
- **Knowledge, not access:** switching off a Service skill changes nothing in the Project configuration; the Gate never reads the rows.

## Considered options

- **Derive the switch from the workspace (on the Agent but absent from disk = switched off).** Rejected: the fan-out restores a pinned Skill missing from disk and the Agent Updates Job re-lays a package's Skills on every release, so a choice held only on disk is undone by the next unrelated change; and absence also means a failed or pending delivery, or an agent that deleted the folder from its shell.
- **A flag on `project_skill_deliveries`.** Rejected: the ledger records only what the backend wrote and drops a row when the Skill leaves the Agent, so it cannot hold a package's Skills or a choice that outlives the Skill.
- **Storing the switched-on set (start empty, opt in per Project).** Rejected: every Skill added to the Agent would reach no existing Project until switched on in each.
- **One switch per Project for every environment.** Rejected: the same bar edits Project configurations per environment and carries them by Publish; two rules in one bar.
- **opencode's `permission.skill` deny instead of removing files.** Rejected: it lives in `opencode.json`, outside the watched roots, so it needs a pod recreate; the files stay readable from the shell.
- **Re-laying the Version recorded at create when a Custom Agent's Skill is switched back on.** Rejected by the owner: switching on means "give this Project the Skill as the Agent has it".
- **Allowing the Platform Skill to be switched off.** Rejected: every Service skill points at its External Services section, and without it the agent guesses URLs and errors.

## Consequences

- An agency covers its clients with one Agent and a few switched-off brand Skills per Project.
- A conversation that already loaded a Skill keeps its text after the switch; the change applies from the agent's next look at its Skills.
- Switching off a Skill the Agent no longer carries in a Custom Agent's Project is final there.
