# A service copy is always a new service made from Development's committed app folder and carries no configuration

An Organization admin wants to start a second Custom External Service from an existing one ("our GitHub service, for a second GitHub org"), or to move one into another Organization or deployment. A Custom External Service is more than its code: it has a builder chat, a Test Project, a Service configuration per environment, Project configurations, `ctx.state`, Calls and a test report. Agent copies already answered the same question for Custom Agents: a copy carries Development only, and always makes something new.

**Duplicate, Export and Import copy only the latest committed `app/` folder of the source's Development, and every copy becomes a new, unpublished Custom External Service with its own builder chat, named and slugged by the admin; nothing else travels.** Concretely:

- **Development's committed `app/` is what travels.** Export and Duplicate read the files at Development's `HEAD`, not the working tree and not a published commit. Uncommitted work is left out, and the dialogs say so; a service whose builder has committed nothing yet has nothing to copy.
- **What travels is the service folder:** manifest, `service.ts` and `src/`, the Service skill, tests, icon, `package.json`, `yarn.lock`, the vendored SDK tarball and README. Yarn caches, Plug'n'Play files, `node_modules` and macOS resource-fork entries are left out on export and skipped on import.
- **Nothing configured travels:** no Service or Development configuration, no Project configuration, no secret, no `ctx.state`, no Calls or usage, no builder chat history, no Test Project and no test report. The admin fills the Service configuration, tests and publishes the copy as any new service.
- **A copy is always new.** Duplicate and Import never update an existing service. Each asks for a name and a slug under the usual slug rules; a slug held by a built-in or another service of the Organization answers a conflict, and Import keeps the upload so the admin resubmits it under a new slug.
- **The files land in the new builder chat's workspace before its pod lays the template**, so a fresh pod keeps them and commits them as its first commit. A workspace taken from Ready Projects already holds the template, so its tracked `app/` files are replaced and the copy is committed on top. Either commit reads "Copied from <source service name>" or "Imported from <file name>".
- **A different SDK major is not refused.** The copy arrives with a warning that the deployment does not serve its SDK major; Publish's own check refuses it. A copy of an SDK 1 service has no upgrade path: its builder rebuilds it on SDK 2.
- **The export file is its own kind.** `<slug>-service-export.zip` holds `manifest.json` (kind `external-service`, export format version, platform and SDK versions, name and slug) and `app/`. Agent and Project import refuse it, and service import refuses theirs.

## Considered options

- **Exporting the published (Default environment) commit.** Rejected: a service not yet published has none, and the admin copying a service wants the code its builder is working on, as Agent copies carry Development.
- **Carrying uncommitted work.** Rejected: a half-written file the builder never committed is not a version anyone reviewed, and the copy would start from a state no commit names.
- **Carrying the Service configuration without secrets.** Rejected: its plain values (base URLs, account ids) belong to the source's upstream account, and a copy pointed at the wrong account is worse than an empty form.
- **Import updating a service with the same slug.** Rejected: it would bypass the builder's review and Publish, and turn a copy into a deployment channel.
- **Reusing Project Duplicate.** Rejected: it refuses builder chats and copies far more than the service folder.

## Consequences

- A copy has no history: its workspace starts from one commit holding the copied folder, and its builder learns the service by reading it.
- A copy taken while the builder has uncommitted changes misses them; the admin asks the builder to commit first.
