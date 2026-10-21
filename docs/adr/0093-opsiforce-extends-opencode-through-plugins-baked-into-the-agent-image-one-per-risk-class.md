# Opsiforce extends opencode through plugins baked into the agent image, one per risk class

Several platform jobs depend on what happens inside opencode: Agent Status, the Prompt stamp that orders the sidebar, and naming a Project after its chat. opencode 2.x loads server plugins that subscribe to its in-process events, and its plugin API carries no stability promise between releases.

**Opsiforce runs its own opencode server plugins, built into the agent image and listed once in the image `opencode.json`. Each plugin holds one risk class, and the first, `opsiforce.observer`, only watches.**

- **Observe, never act.** The observer subscribes to opencode's events and posts what it saw to the Service Gateway: a run started or ended in an opencode session, a root session was titled, a user item entered a root session's inbox. It registers no hook on the turn path (prompt, context, tool, permission), so a bug in it can make a signal stale but never fail a turn. A later plugin that does sit on the turn is its own plugin, never added to the observer.
- **Thin plugin, rules in the backend.** The observer reports in opencode's terms and decides nothing: what counts as Working, which title names the Project, and which item is a Prompt are backend rules, changed by a backend deploy with no image or pod change. This is the "report facts, never decide" rule of [ADR-0036](0036-agent-session-is-the-backends-only-door-to-a-pods-opencode-port.md) applied inside the pod. The observation contract is additive: the backend ignores kinds it doesn't know.
- **Baked into the image beside the binary.** One Yarn workspace, `opencode-plugins/`, builds each plugin into a self-contained bundle under `/opt/opsiforce/opencode-plugins/<name>/`, read-only, with `@opencode/plugin` pinned to the exact opencode build. The image `opencode.json` lists each plugin by absolute path, and Agent Updates merge it into every workspace's config ([ADR-0024](0024-agent-opencode-config-lives-in-the-workspace-opencode-dir.md)). A plugin change ships as an image bump and a pod recreate, like an opencode bump.
- **One plugin per risk class.** opencode loads, isolates and reports each plugin separately (`GET /api/plugin` shows each one `active` or `failed`), so a plugin with turn-path hooks can fail without taking the observer with it. Plugin ids are prefixed `opsiforce.`.
- **No fallback producer.** A pod whose observer failed to load has no Working signal, no Project title from its chat and no Prompt stamps; its turns still work. Nothing outside opencode produces these signals as a backup, because two producers would race. Readiness never waits for a plugin.
- **Fast, guarded setup.** A plugin's `setup` does no awaited I/O and throws only when its own inputs are missing (the gateway URL or key), so a misconfigured pod shows `failed` instead of reporting nothing. Every event handler and every hook runs inside a guard that logs a throw and never rethrows; on opencode 2.x a throw in `execute.after` still fails the user's turn.

## Considered options

- **Written into the workspace `.opencode/plugins/` by the Agent Updates Job.** Restart-free, but the plugin and the binary drift until each environment's Job lands, and the Agent's root shell can delete it.
- **Fanned out by the backend like Skills, or installed from a pinned npm package.** More drift between plugin and binary, and an npm package installs from the registry at runtime into the workspace cache.
- **A thick plugin that holds the rules.** Every rule change becomes an image rebuild and a fleet-wide pod recreate.
- **One plugin for everything.** A turn-path hook's failure would take the status, title and Prompt signals down with it.
- **Keep an outside producer as a fallback.** Two producers race on the same state, and the fallback hides a failed plugin.
- **Make readiness wait for the observer.** A status outage would become a chat outage, and recreating the pod can't fix a bug in the image.
- **A CI smoke test or a runtime check of plugin state.** A load failure is per image (the same binary and plugin bytes on every pod), so one runbook check of `GET /api/plugin` on a development pod per image catches it before production.

## Consequences

- Every opencode bump re-checks the plugin API in its delta note, and the plugin moves in lockstep with the binary.
- A plugin needs no gateway credential of its own: the observer uses the gateway key already in opencode's environment.
- Plugins switch off together with `"-opsiforce.*"` in the plugin list.
- A plugin for some Agents only would need Agent Updates to merge per-package plugin lists; that is that plugin's own decision.
