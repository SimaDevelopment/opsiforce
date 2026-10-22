# A Custom External Service carries its own copy of the SDK and upgrades it only when asked

A Custom External Service is a Project App written against `@opsiforce/external-service-sdk`, but the platform publishes no package to any registry, and the agent image only seeds a workspace once. Everything after that seed must survive pod recreates, newer images and Publish's git copy into Production.

**The SDK lives in `packages/opsiforce/external-service-sdk/` and the agent image packs it into a versioned tarball; the External Service Builder's template commits that tarball into the service's `app/vendor/` and installs it from there, so every Custom External Service runs the SDK version it was built and published with until a human asks the builder to upgrade it.** Concretely:

- **The workspace owns its copy.** `app/package.json` names `file:./vendor/external-service-sdk-<version>.tgz`; the version is in the file name because `yarn.lock` records the tarball's checksum, so an upgrade adds a new file and changes `package.json`, `yarn.lock` and the tarball in one commit. Production gets the same files from Publish.
- **The service stays on Yarn Plug'n'Play with the SDK unplugged**, so the builder reads the README, CHANGELOG and type declarations of the version the service actually runs, as plain files. The agent image also keeps the newest SDK unpacked and read-only, for reading what an upgrade brings.
- **The platform serves every SDK of the `sdk` major it accepts**, `2` (from `2.0.0`, declared as `"sdk": 2`). A minor version only adds optional things; the service's page reads the version from the vendored tarball's name and offers an upgrade when the platform's release ships a newer one. A wire-breaking change is a new `sdk` major. A service built on an older major is served nowhere: its page says to rebuild or delete it, Publish refuses it, and the platform converts nothing.
- **Built-in External Services live in `packages/opsiforce/external-services/<name>/`**, in the same folder shape as a custom one, importing only the SDK and their own npm dependencies. The package boundary is what keeps "a Custom External Service becomes built-in by committing its folder" true, and the agent image copies these folders read-only for the External Service Builder to study. Built-ins always run the SDK of their own commit.

## Considered options

- **Publishing the SDK to npm.** Rejected: no registry or release pipeline exists, and it would make the SDK public before the platform's code is.
- **Pointing `package.json` at the tarball inside the image.** Rejected: the next image removes that file, and a Production pod reinstalling on restart fails.
- **Serving the tarball from a backend endpoint.** Rejected: an endpoint and an authentication question for what a committed file does.
- **Copying the SDK's source into the template.** Rejected: an installed dependency's TypeScript is not run by Node, so every service would need a build step, and a copy the builder can edit turns each later upgrade into a merge.
- **Upgrading every service automatically through the builder's agent migrations, or on a Production restart.** Rejected: a migration would break unattended drafts, and a restart would put code no human reviewed in front of callers, past the Publish review.
- **Keeping the built-ins inside `backend/src`.** Rejected: nothing there stops a built-in from importing backend internals, and a reference that does teaches the builder what a Custom External Service can never do.

## Consequences

- Published services drift across SDK minors; the Gate's compatibility with a whole `sdk` major is a contract every SDK release must keep.
- Each service's git history carries the SDK tarballs it has used.
