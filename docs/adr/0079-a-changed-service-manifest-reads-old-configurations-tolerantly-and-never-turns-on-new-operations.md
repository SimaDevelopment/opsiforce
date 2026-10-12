# A changed Service manifest reads old configurations tolerantly and never turns on new Operations

A Service configuration and every Project configuration are stored values filled into Forms that the Service manifest declares, and the manifest changes: a Custom External Service is republished, and a Built-in External Service ships a new `service.json` with a backend release. Trello v2 renames `boards` to `boardIds`, turns `defaultList` from a select into a multiselect, drops `events`, adds `archive_card` and removes `delete_card`, while dozens of Project configurations still hold the old values.

**The platform keeps stored values as they are and reads them against the current manifest tolerantly, and an Operation a stored configuration has never seen stays denied.** Concretely:

- **A rename is declared, not guessed.** The new field says `"key": "boardIds", "was": "boards"`, and an old value moves to the new key when read.
- **A value that no longer fits its field counts as missing.** When that field is required, the configuration is shown as needing attention and the Gate refuses calls to that service from that ProjectEnvironment with `409 configuration-incomplete` until someone saves it again.
- **Removed fields and Operations stay in storage and are never delivered**, so rolling a Publish back brings them back.
- **An Operation missing from a stored `operations` map is denied.** The defaults by kind (read on, write and destructive off) apply only to a configuration created after the Operation existed; a configuration written from a Custom Agent's Service settings (Agent) has on exactly the Operations the settings name ([ADR-0089](0089-a-custom-agents-service-settings-seed-a-real-project-configuration-in-every-new-project.md)). A service that adds a read Operation never widens what an existing Project may do.
- **Publish shows the impact before it happens**, for example "3 Project configurations: `boards` → `boardIds`; 1 needs attention (`defaultList`); `archive_card` off in 3". A Built-in External Service gets the same rules when the backend boots with its new manifest.

## Considered options

- **Refusing a Publish while any stored configuration fails the new Forms.** Rejected: a rename would mean hand-editing every consuming Project first, and a Built-in's release could not ship at all.
- **A `migrate(values, fromHash)` handler in the service's code.** Rejected: it is tenant code that must run over every stored configuration at Publish, a buggy one corrupts values for good, and old hashes accumulate forever.
- **Giving new Operations the defaults by kind in existing configurations.** Rejected: an author could quietly grant every consuming Project a new read Operation by publishing.

## Consequences

- Stored configurations can carry keys the current manifest does not know; validation and delivery always go through the current Forms, never the raw stored document.
