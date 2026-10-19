# A changed Service manifest reads old configurations tolerantly, and a Publish writes each new field's default into them

A Service configuration and every Project configuration are stored values filled into Forms that the Service manifest declares, and the manifest changes: a Custom External Service is republished, and a Built-in External Service ships a new `service.json` with a backend release. GitHub v2 renames `repos` to `repositories`, turns `access` from a toggle into a select, and adds `allowMergePullRequests` (a toggle, default on) and `maxOpenPullRequests` (a number, default 10), while forty Project configurations still hold the old values. The service's Service policy reads those values on every request ([ADR-0046](0046-an-external-service-owns-its-api-and-its-service-policy-the-gate-only-identifies-the-caller-finds-the-service-and-forwards-the-call-untouched.md)), and the Project configuration dialog shows them.

**The platform keeps stored values, reads them against the current manifest tolerantly, and when a Publish adds a field it writes that field's default into every stored configuration, shown in the Publish review before it happens. A form's default is a starting value only: for a new configuration and for a field arriving with a Publish.** Concretely:

- **A rename is declared, not guessed.** The new field says `"key": "repositories", "was": "repos"`, and an old value moves to the new key when read.
- **A value that no longer fits its field counts as missing.** When that field is required, the configuration is incomplete: the dialog shows it as needing attention, and the service's SDK refuses that ProjectEnvironment's calls with a message naming the field ([ADR-0078](0078-an-external-service-fetches-its-configurations-from-the-backend-by-the-caller-identity-and-holds-them-only-in-memory.md)) until someone saves it again. A required field added without a default is missing in every stored configuration in the same way.
- **A Publish writes new defaults in.** Every configuration stored before the Publish gets each new field's default, so the dialog, the delivered values and the Service policy agree, and a Project created before the Publish behaves like one created after it. The review lists it first: "new setting *Merge pull requests* = on in 40 configurations; *Max open pull requests* = 10 in 40". A Built-in External Service does the same when the backend boots with its new manifest.
- **A later default change reaches no stored configuration.** Changing `allowMergePullRequests` to default off in v3 changes only configurations created after v3, as a person's save would.
- **The dialog marks a field a Publish wrote in as new** until a person saves the configuration; the configuration remembers which keys a Publish filled.
- **Removed fields stay in storage and are never delivered**, so rolling a Publish back brings them back.
- **The platform does not know which field is dangerous.** A field that widens what a Project may do is guarded by the author choosing its default, seen by a human at the External Service Builder's approval stop and again in the Publish review.

## Considered options

- **Refusing a Publish while any stored configuration fails the new Forms.** Rejected: a rename would mean hand-editing every consuming Project first, and a Built-in's release could not ship at all.
- **A `migrate(values, fromHash)` handler in the service's code.** Rejected: it is tenant code that must run over every stored configuration at Publish, a buggy one corrupts values for good, and old hashes accumulate forever.
- **A field no one saved stays absent.** The forty configurations would get `undefined` for `allowMergePullRequests`, and the dialog would show it off. Rejected: old and new Projects would behave differently for good, every policy would need a fallback for each field, and a builder who knew the default was on and wrote `?? true` would make the dialog disagree with what the service enforces.
- **Filling missing fields with their defaults on every read.** Rejected: a later default change would silently move only the configurations no one had saved since, and no one could tell which those were.
- **Keeping new capabilities off in older configurations.** Rejected: the author's code is the enforcement and can widen access by changing one condition, so the rule protects nothing and only splits old Projects from new ones.

## Consequences

- Stored configurations can carry keys the current manifest does not know; validation and delivery always go through the current Forms, never the raw stored document.
- A Publish that adds fields writes to every stored configuration of that service, bumping each one's version, so each consuming service fetches it once more.
