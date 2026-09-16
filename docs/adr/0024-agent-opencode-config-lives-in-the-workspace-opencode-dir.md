# The agent-owned OpenCode config lives in the workspace `.opencode` directory

Status: accepted

The agent-owned `opencode.json` (model, provider whitelist, permissions, plugin list) was written to the workspace's XDG config location — the path vendored OpenCode treats as the *user-global* config. That location has two properties that broke platform rollouts. First, OpenCode reads it once per process into a module-level memo with no invalidation, so the dispose-based reload used by Agent Updates — which works for the agent prompt and skills — could not refresh it: the pipeline stamped the ledger and recorded `disposed`, yet the running pod kept serving the old model and whitelist until an unrelated restart (observed on the gpt-5.6-sol rollout, 2026-07-21). Second, it sits at the *lowest* file precedence, so any `opencode.json` a user's repo ships silently overrode the platform's model, whitelist, and permissions.

**The config moves to the workspace's `.opencode` directory**, alongside the agent definition and skills. OpenCode scans `.opencode/opencode.json` on every instance rebuild at the *highest* file precedence, so a config-only rollout now lands on running pods through the existing dispose reload — no pod restart — and platform config wins over anything a user's repo ships. That precedence inversion is a deliberate policy decision, not a side effect: the platform's model, whitelist, and permission set are authoritative, and an imported repo can no longer repoint them. Everything moves, including the `plugin` list (its `file://` URL into the agent image resolves identically from the new location). No vendored-OpenCode change is required or permitted.

A one-shot workspace migration (`20260803_relocate_opencode_config`) deletes the old file and declares `requiresPodRecreate: true` — required because running processes hold the frozen memo and cannot be repaired from outside. It ships in both Agents' migration directories (the private agent's first), deletes via an idempotent script operation rather than a checksum-managed delete (the old file's content varies per Project, so managed checksums would conflict), and is the last restart this class of change needs: afterwards the memo location is empty everywhere and caches an empty result harmlessly.

User-written provider config in the old file is not preserved. It was never functional — writes landed in the frozen-memo location and were overwritten by the init container at the next pod start — and custom providers bypassing the LLM gateway are policy-undesirable anyway.

## Considered options

- **Patch vendored OpenCode's global-config memo to be invalidatable** — rejected: it forks the vendored dependency for a problem the platform can solve by using the config surface OpenCode already reloads, and every vendor update would have to re-carry the patch.
- **Set the persistent registry-level recreate flag (`workspaceUpdate.requiresPodRecreate`)** instead of a one-shot migration — rejected: it recreates every pod on every future version bump until someone remembers to remove it; the cost must be bounded to the transition.
- **Split the config by lifetime** (reloadable parts to `.opencode`, static parts left behind) — rejected: two config sources with different reload semantics recreates the exact class of "which changes actually land?" confusion this decision removes, for no benefit — the whole file relocates cleanly.

## Consequences

- The Agent Updates guarantee "agent-owned files reload via dispose" is now uniformly true for all three artifact kinds (prompt, skills, config) — see [Agent Updates](../agent-system/agent-updates.md).
- Platform config outranks project-shipped `opencode.json` files. This is the intended policy.
- Published (non-default) environments are excluded — the sweep targets default environments only. Bounded consequence: after its next publish-driven pod start a published environment loads both files (the new one via the init-container sync; the old one is never deleted there). Harmless because both files carry the same settings; a follow-up may extend the init-container sync to delete the old file.
- Private-agent Projects have no ledger under their own Agent's name, so their first agent-aware sweep runs every migration in that Agent's directory — exactly this one, because the directory is otherwise empty. Backfilling that directory later invalidates this assumption and must be done knowingly. They also absorb one extra pod recreate during the transition (one under the old app-builder identity from a prior bump, one under their own).
- The agent image and backend must deploy together: the backend supplies the target version, the image supplies file contents and the migrate script; skew between them is what produced the false "applied" ledger stamp on 2026-07-21.
