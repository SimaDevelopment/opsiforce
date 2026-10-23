# A Service manifest can connect every new Project to the service

A ProjectEnvironment is connected to an External Service only while it holds a Project configuration, and a configuration normally comes from a person saving the chat bar's dialog or from a Custom Agent's Service settings (Agent) ([ADR-0089](0089-a-custom-agents-service-settings-seed-a-real-project-configuration-in-every-new-project.md)). Some services need no choice from anyone: Incoming email only generates an address, and an App that can receive mail the moment its Project exists is the behaviour people expect.

**A Service manifest that sets `"connectedByDefault": true` connects every new Project of the service's Organization while the service is Available: the Project starts with a Project configuration made from the Project form's defaults and generated values, as if a person had saved the form untouched.** Concretely:

- **Any Agent.** Built-in and Custom Agents alike; a Custom Agent's Service settings (Agent) for the service overlay the defaults, and its Test Projects and Builder chats are new Projects too.
- **Every way a new Project comes to exist:** create (UI, Public API, Workspace, a pool claim), Project Duplicate and Import, written and announced at the same moments as Service settings (Agent). Publish carries Development's configuration forward with fresh generated values, so each published environment has its own.
- **New Projects only.** An existing Project is never connected afterwards, and a Disconnect stays.
- **The author decides.** Only a service whose Project form needs no person's choice sets it; Incoming email does, WhatsApp (a linked account per Project) and the Public API built-in (deliberate switches) do not.

## Considered options

- **A per-Organization or operator setting.** Rejected: whether a service is usable without a person's choice is a fact about its Project form, which its author knows, and a setting would let an untouched form be connected for a service that needs one.
- **A provisioning hook the service runs at create.** Rejected: the platform already writes a configuration from the form's defaults and generated values; a hook would be a second, service-specific way to do the same.
- **Connect on first use.** Rejected: an Agent learns the service from its Service skill, which arrives only once the environment is connected.

## Consequences

- Every new Project of an Organization holds a live address for each such service from its first message, whether or not anyone uses it.
