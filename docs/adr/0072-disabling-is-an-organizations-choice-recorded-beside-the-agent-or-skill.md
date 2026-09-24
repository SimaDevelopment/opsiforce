# Disabling is an Organization's choice, recorded beside the Agent or Skill rather than on it

[ADR-0070](0070-skills-and-agents-are-disabled-like-projects-not-archived.md) made Disable the one word for taking an Agent or a Skill out of use, but kept it as a `disabled` column on the row. That works for a Custom Agent or Skill, which one Organization owns. It cannot work for a Built-in Agent or a Built-in Skill, which are global rows every Organization shares, and the owner wants both kinds disabled the same way.

**Disabling records a row in `tenant_disabled_agents` or `tenant_disabled_skills`, keyed by the Organization and by the Agent or Skill; enabling deletes it. The `disabled` columns are gone, and every read asks whether a row exists for the caller's Organization.** Concretely:

- **A sparse table per kind, for both origins.** A row exists only while the Organization has the Agent or Skill disabled, so nothing is backfilled: a new Organization, or a newly shipped Built-in, needs no rows. It carries who disabled it and when. Migration 0072 moves every disabled Custom row into the tables, then drops the columns.
- **One predicate.** `visibleAgentsWhere` and `visibleSkillsWhere` exclude rows the Organization disabled, and the Store's `disabled` filter includes only those. The pickers, the create-Project checks and the public API's list and create inherit that. The API's `disabled` field now means "disabled in the caller's Organization", which for a Custom row means what it did before.
- **Built-ins may be disabled, with two limits.** An Organization cannot disable its last enabled Built-in Agent that starts Projects, so new Projects always have one to start on; the check and the write run under one lock per Organization, so two concurrent disables cannot both pass. `skill-agent-builder` never counts toward that and is never disabled. The `platform` Skill is never disabled either, because every new Agent pins it.
- **The default follows the Organization.** A create that names no Agent — the home page's quick create, workspace create, import's fallback — starts on `app-builder` while the Organization has it enabled, and otherwise on the first Built-in Agent it still has on. Import resolves an Agent the Organization disabled to nothing, so it falls back too.
- **Nothing below the check changes.** The warm pool is global and holds no Organization until a claim, which only happens after the check passes, so a disabled Agent is simply never claimed. Existing Projects keep running and keep receiving agent updates and Skill fan-out, as a disabled Custom Agent always did.

## Considered options

- **A `disabled` flag on the Built-in Agent's lazily created Development profile** — rejected: a profile is one Environment's definition, and disabling is Organization-wide availability. It would also leave Custom Agents on a second mechanism.
- **A row per Built-in Agent per Organization** — rejected by the owner: it is a backfill, repeated for every new Organization and every newly shipped Agent, for a default that is "enabled".
- **Keep the columns for Custom rows and add tables for Built-in ones** — rejected: every read would OR two sources for one fact.
- **A general `tenant_agent_states` table** — rejected: the row's existence is the whole fact, and per-Organization settings for a Built-in Agent would need their own columns and their own table.
- **Never allow disabling `app-builder`** — rejected by the owner in favour of the last-one rule and an Organization-aware default.

## Consequences

- Retires ADR-0070's `agents.disabled` and `skills.disabled` columns; its vocabulary and routes stand.
- Duplicating a Project whose Agent is disabled in the Organization is not refused yet: duplicate copies the source's Agent.
