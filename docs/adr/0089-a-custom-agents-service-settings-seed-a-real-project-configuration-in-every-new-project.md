# A Custom Agent's service settings seed a real Project configuration in every new Project

A Custom Agent built for one job (a PR reviewer, a stand-up digest) needs the same service settings in every Project created from it: pull requests allowed, merging off, `issue.opened` received. A new Project configuration starts from the Project form's defaults, and nothing else is set until a person saves the dialog in each Project. The targets (repositories, boards, numbers, chats) differ per Project anyway.

**A Custom Agent carries Service settings (Agent) for each Service skill on its Agent Profile: values for the service's Project-form fields other than its targets. When a Project of the Agent comes to exist, the platform writes a real Project configuration from them over the form's defaults, as if a person had saved it, runs the service's save hook as the platform when the configuration is complete, and delivers the Service skill.** Concretely:

- **Everything but targets.** A target is a field a Project picks inside its own world: a field whose options come from a call to the service (repositories, boards), a `secret`, a `generate`d or a `unique` field. Toggles, numbers, text and selects with fixed options may be set. The Agent page renders the service's Project form without its targets. A configuration created without a required target "Needs attention", runs no save hook, and the service refuses its calls until someone picks it in the Project; that save runs the hook.
- **A snapshot at creation.** Later changes to the settings never reach existing Projects. A field the service adds later takes its default in new Projects until the settings set it, and a field the service no longer declares is ignored.
- **Every way a Project of the Agent comes to exist:** create (UI, Public API, Workspace), the Agent's Test Project, Project Duplicate and Project Import. The configuration is written before the Agent's files are delivered and the hook runs after, so the two deliveries never race; a Project Duplicate or Import delivers its Service skills before the hook too; a hook failure leaves the usual "Saved, but …" Retry and the Project is still created.
- **Only a person sets them.** Setting any Service settings needs `can_configure_project_external_services` as well as the Agent permission, checked when the Agent is edited and when Agent Duplicate or Import writes a copy; creating a Project checks nothing again. The platform cannot tell which field widens what a Project may do, so it guards all of them. A Duplicate or Import by someone without that permission drops the copy's Service settings, saying so. The Skill & Agent Builder cannot read or set them through the Public API.
- **Custom Agents only.** A Built-in Agent's Projects keep per-Project configuration.
- **Settings travel with the Skill pin:** they live on the Development profile, move to Production with the Agent's Publish, and Agent Duplicate, Export and Import carry them by field key. Import drops keys the importing Organization's service lacks, and a service that is not Available there, saying so in its notes.

## Considered options

- **Prefill only.** The dialog opens with the Agent's values but nothing is stored until a person saves in each Project. Rejected: every Project still needs a person, which is what the settings remove.
- **Live inheritance.** Projects read the Agent's settings at call time. Rejected: the service would merge two documents on every call, and every Agent edit would fan out a save hook to every Project.
- **The whole Project form, targets included.** Rejected for this version: targets name things inside one Project's world, and a wrong default quietly widens a Project's reach.
- **No Service settings on an Agent.** Rejected: every Project of a single-purpose Agent would need a person to configure it.

## Consequences

- A Project configuration can exist from the first message with capabilities on that no person saved in that Project, and no record names who seeded it: the seeding hook reaches the service as the platform acting for that ProjectEnvironment, never as a person.
- The Agent page renders a service's Project form without a Project, so the form renders without a Project's live option lists.
