# Agent model is owned by agent-config, not a tenant/platform default

**An agent's model is part of the agent's own definition, never a tenant or platform default.** A Built-in Agent's `model` and `variant` come from its entry in `agent-config/agents.json` and ship with the agent image and its skills. A Custom Agent's model is the validated `model` + `variant` pair on its Agent Profile ([ADR-0058](0058-a-custom-agent-holds-one-definition-per-environment-and-a-project-keeps-the-files-it-was-created-with.md)), checked against the model catalog ([ADR-0032](0032-model-catalog-is-a-file-in-the-agent-image.md)). Timeouts and budgets are the only two-tier (platform, then Organization) defaults.

**Why the asymmetry is deliberate.** Timeouts and budgets are operational knobs that legitimately differ per Organization (a trial on a tight budget, an enterprise on a loose one) and are consumed when Projects and keys are created. The model is not an operational knob: changing it alters agent behaviour, prompt-token economics and context limits in lockstep with the agent's instructions and the per-model `limit`/`reasoningEffort` config in `opencode.json`. Splitting it away from that config into a per-Organization column invites mismatches (a selected model with no matching context-limit block) and gives no operational benefit.

## Considered options

- **Per-Organization model selection** (a `default_model` in the defaults tables, read at pod creation, with a tenant UI). Rejected: it makes per-Organization model choice a product surface we do not want, and forks the model away from the per-model config in `opencode.json`, where the two must stay in step.

## Consequences

- A Built-in Agent's model reaches the workspace `opencode.json` when the image's content is laid or updated in it ([ADR-0060](0060-agent-files-are-laid-once-and-shared-with-the-backend-by-ownership-list.md)); a Custom Agent's model is written into its agent file's frontmatter at delivery. The baked default in `opencode.json` / `opencode.local.json` mirrors the default Built-in Agent's model.
- [Defaults](../organization/defaults.md) covers **timeouts and budgets only**, gated by `can_manage_platform_defaults` / `can_manage_tenant_defaults`.
- Migration `0014` creates agent-defaults tables that `0043` drops; nothing reads a model from the database defaults.
- Per-Organization or per-Project model selection would be an explicit new decision (a migration and endpoints), not the completion of existing scaffolding.
