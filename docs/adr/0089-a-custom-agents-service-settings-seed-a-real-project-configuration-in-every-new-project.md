# A Custom Agent's service settings seed a real Project configuration in every new Project

A Custom Agent built for one job (a PR reviewer, a stand-up digest) needs the same Operations and Event types on in every Project created from it, yet a new Project configuration starts from the manifest (reads on, writes and destructive Operations off, every Event off) and nothing is on until a person saves the dialog in each Project. The targets (repositories, boards, numbers, chats) differ per Project anyway.

**A Custom Agent carries Service settings (Agent) for each Service skill on its Agent Profile: the names of the Operations and Event types that are on. When a Project of the Agent comes to exist, the platform writes a real Project configuration from them, as if a person had saved it, runs the service's save hook with the Project's creator when the configuration is complete, and delivers the Service skill.** Concretely:

- **Operations and Events only.** Targets, secrets, generated and unique values are never part of the settings; a configuration created without a required target "Needs attention", runs no save hook, and the Gate answers `409 configuration-incomplete` until someone picks it in the Project; that save runs the hook.
- **A snapshot at creation.** Later changes to the settings never reach existing Projects. The settings hold names: an Operation the service adds later is off in new Projects until the settings name it, and a name the service no longer declares is ignored.
- **Every way a Project of the Agent comes to exist:** create (UI, Public API, Workspace), the Agent's Test Project, Project Duplicate and Project Import. The configuration is written before the Agent's files are delivered and the hook runs after, so the two deliveries never race; a Project Duplicate or Import delivers its Service skills before the hook too; a hook failure leaves the usual "Saved, but …" Retry and the Project is still created.
- **Only a person grants a write.** Turning a write or destructive Operation on in the settings needs `can_configure_project_external_services` as well as the Agent permission, checked when the Agent is edited and when Agent Duplicate or Import writes a copy; creating a Project checks nothing again. A Duplicate or Import by someone without that permission keeps the copy's reads and Events and turns its write and destructive Operations off, saying so. The Skill & Agent Builder cannot read or set the settings through the Public API.
- **Custom Agents only.** A Built-in Agent's Projects keep per-Project configuration.
- **Settings travel with the Skill pin:** they live on the Development profile, move to Production with the Agent's Publish, and Agent Duplicate, Export and Import carry them by name. Import drops names the importing Organization's service lacks, and a service that is not Available there, saying so in its notes.

## Considered options

- **Prefill only.** The dialog opens with the Agent's switches but nothing is stored until a person saves in each Project. Rejected: every Project still needs a person, which is what the settings remove.
- **Live inheritance.** Projects read the Agent's settings at call time. Rejected: the Gate would merge two documents on every call, and every Agent edit would fan out a save hook to every Project.
- **Default targets in the settings.** Rejected for this version: targets name things inside one Project's world, and a wrong default quietly widens a Project's reach.

## Consequences

- A Project configuration can exist from the first message with writes on that no person saved in that Project; the call log names the Project's creator on the seeding hook call.
- The Agent page edits Operation and Event switches without a Project, so the switch components work without a Form.
