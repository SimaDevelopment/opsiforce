# Skills and Agents are Disabled per Organization, like Projects

Taking something out of use, reversibly, while whatever already depends on it carries on, is one act whether the thing is a Project, a Skill or an Agent. Built-in Agents and Built-in Skills are global rows every Organization shares, so the choice to stop using one has to belong to the Organization, not to the row.

**Disable is the one word for taking a Project, a Skill or an Agent out of use, and Enable the one word for bringing it back. For Skills and Agents, disabling records a row in `tenant_disabled_skills` or `tenant_disabled_agents` for the caller's Organization, and enabling deletes it.** Concretely:

- **One vocabulary everywhere.** The routes are `POST /agents/:id/disable` and `/enable`, and `POST /skills/:id/disable` and `/enable`. The Store filter is `disabled`, the response field is `disabled` beside `disableable`, and the error codes are `skill_disabled`, `skill_not_disabled`, `agent_not_disabled`, `not_disableable` and `last_built_in_agent`.
- **A sparse table per kind, for both origins.** A row exists only while the Organization has that Skill or Agent disabled, keyed by `(tenant_id, skill_id)` or `(tenant_id, agent_id)` and carrying who disabled it and when. A new Organization or a newly shipped Built-in needs no rows. `disabled` in the API always means "disabled in the caller's Organization"; another Organization is unaffected.
- **One predicate.** `visibleSkillsWhere` and `visibleAgentsWhere` exclude what the Organization disabled, and the `disabled` filter shows only those, for holders of the matching permission. The pickers, the create-Project check and the public API's lists and creates inherit it.
- **What Disable closes.** A disabled Agent is not offered for new Projects. A disabled Skill is hidden from the Store, cannot be added to an Agent and takes no new Version. Existing Projects keep running and keep receiving Agent Updates and Skill delivery, and Agents that already carry a disabled Skill keep it.
- **Only the meaning is shared, not the mechanism.** Disabling a Project stops its pods. Disabling a Skill or an Agent stops nothing and only closes it to new use.
- **Built-ins may be disabled, within limits.** An Organization cannot disable its last enabled Built-in Agent that starts Projects; the count and the write run under one advisory lock per Organization, so two concurrent disables cannot both pass. `skill-agent-builder` never counts toward that and is never disabled. The `platform` Skill is never disabled, because every new Custom Agent carries it. Disabling a Built-in needs the matching permission; a Custom row follows the edit rule of [ADR-0057](0057-authored-skills-and-agents-are-private-or-public-within-one-organization.md).
- **The default Agent follows the Organization.** A create that names no Agent (quick create, workspace create, import's fallback) starts on `app-builder` while the Organization has it enabled, and otherwise on the first enabled Built-in Agent by name. Import resolves an Agent the Organization disabled to nothing, so it falls back too.
- **Nothing below the check changes.** A pending pool slot ([ADR-0041](0041-new-projects-are-claimed-from-a-pool-of-pending-projects.md)) holds no Organization until a claim, and a claim happens only after the check passes, so a disabled Agent's slots are simply never claimed.
- **A Builder chat offers no Disable.** The menu does not offer it, though `POST /projects/:id/disable` does not refuse a chat, and opening the chat from an enabled subject enables it again. A chat for a disabled subject cannot be opened for the first time.

## Considered options

- **A different word in the schema and the API than on the button**: rejected. A route and a response field that disagree with the button that calls them leave the next reader to rediscover the synonym.
- **A `disabled` flag on the Built-in Agent's Development profile**: rejected. A profile is one Environment's definition, while disabling is Organization-wide availability, and Custom Agents would need a second mechanism.
- **A row per Built-in Agent per Organization**: rejected. It is a backfill, repeated for every new Organization and every newly shipped Agent, for a default that is "enabled".
- **A column for Custom rows and a table for Built-in ones**: rejected. Every read would combine two sources for one fact.
- **A general `tenant_agent_states` table**: rejected. The row's existence is the whole fact, and per-Organization settings for a Built-in Agent would need their own columns anyway.
- **Never allowing `app-builder` to be disabled**: rejected in favour of the last-one rule and an Organization-aware default.

## Consequences

- Duplicating a Project whose Agent is disabled in the Organization is not refused: duplicate copies the source's Agent without the create-Project check.
