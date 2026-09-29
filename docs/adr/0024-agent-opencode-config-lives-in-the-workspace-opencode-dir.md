# The agent-owned OpenCode config lives in the workspace `.opencode` directory

The agent-owned `opencode.json` (model, provider whitelist, permissions, plugin list) needs a location that OpenCode reloads when the file changes, and one where the platform's settings cannot be overridden by a repo. The workspace XDG config location fails both: OpenCode treats it as the *user-global* config at the *lowest* file precedence, so any `opencode.json` a user's repo ships overrides it.

**The agent-owned config lives at `/workspace/.opencode/opencode.json`**, beside the agent definition and skills. OpenCode watches `.opencode/` and rebuilds config on change ([ADR-0030](0030-agent-owned-file-changes-need-no-opencode-reload.md)), so a config-only rollout lands on running pods with no pod restart. `.opencode/` sits at the *highest* file precedence, so platform config wins over anything a user's repo ships. That is a deliberate policy: the platform's model, whitelist and permission set are authoritative, and an imported repo cannot repoint them. The whole file lives there, including the `plugin` list (its `file://` URL into the agent image resolves from any location). No vendored-OpenCode change is required or permitted.

The image's `agent-workspace-migrate` script owns the file ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)). Every Agent Update Job rebuilds it from the image config and the registry entry, in `content` mode on every environment and in `full` mode on Development. The workspace migration `20260803_relocate_opencode_config` deletes the legacy XDG file and declares `requiresPodRecreate: true`, because a process that loaded the old location cannot be repaired from outside.

User-written provider config is not preserved: the script rebuilds the file from the image config and keeps only backend-owned agent blocks and the default agent, and custom providers that bypass the LLM gateway are against policy.

## Considered options

- **Patch vendored OpenCode's global-config memo to be invalidatable** — rejected: it forks the vendored dependency for a problem the platform solves by using the config surface OpenCode already reloads, and every vendor update would have to re-carry the patch.
- **Set the persistent registry-level recreate flag (`workspaceUpdate.requiresPodRecreate`)** instead of a one-shot migration — rejected: it recreates every pod on every future version bump until someone removes it; the cost must be bounded to the move.
- **Split the config by lifetime** (reloadable parts in `.opencode`, static parts in the XDG location) — rejected: two config sources with different reload semantics bring back the "which changes actually land?" confusion, and the whole file fits in `.opencode`.

## Consequences

- Prompt, skills and config all reload the same way — see [Agent Updates](../agent-system/agent-updates.md).
- Platform config outranks project-shipped `opencode.json` files. This is the intended policy.
- The agent image and backend deploy together: the backend supplies the target version, and the image supplies the file contents and the migrate script. Skew between them can stamp a version whose files never landed.
