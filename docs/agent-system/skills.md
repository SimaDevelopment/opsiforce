---
kind: explanation
terms: [Skill, Built-in Skill, Custom Skill, Visibility, Skill Version, Publish (Skill), Agent Skills, Update available, Skill Store, Archive (Skill), Delete (Skill), Duplicate (Skill)]
adrs: [0051, 0059]
---

# Skill

> What a Skill is made of, how a Version is published and validated, and how an Organization's catalog is scoped and retired?

## How it works

### The catalog

- A [Skill](../../CONTEXT.md) is a directory with a `SKILL.md` and optional supporting files, stored as rows rather than on disk: `skills` holds identity, `skill_versions` an immutable content snapshot, and `skill_version_files` one row per file with its bytes, size, binary flag and executable bit. A [Built-in Skill](../../CONTEXT.md) is the global row (`tenant_id IS NULL`, `origin = 'built_in'`) the boot reconciler mints from the agent image; a [Custom Skill](../../CONTEXT.md) belongs to one Organization ([ADR-0051](../adr/0051-skill-catalog-append-only-store-tables.md)).
- Content exists **only** as a published [Skill Version](../../CONTEXT.md): there is no draft row and no save short of publishing, and a Version once written is never edited ([ADR-0059](../adr/0059-skills-exist-only-as-published-versions-and-a-built-in-agents-skills-live-on-a-development-profile.md)). Version numbers are per Skill and unique, and a Version is minted only when the tree hash differs from the newest one, so republishing identical content is a no-op.
- [Visibility](../../CONTEXT.md) is a column on the Skill, not on a Version: **private** means listed and editable only for its creator, **public** hands it to the whole Organization. Making it public is irreversible; [Duplicate (Skill)](../../CONTEXT.md) into a fresh private Skill is the way back ([ADR-0057](../adr/0057-authored-skills-and-agents-are-private-or-public-within-one-organization.md)).
- The [Skill Store](../../CONTEXT.md) list is one predicate over those columns — Built-in Skills, the Organization's public Custom ones, and the caller's own private ones — narrowed by a `filter` of `all`, `built_in`, `custom`, `private` or `archived` and a `q` search, both carried in the URL.
- A Built-in Skill whose name leaves the image keeps its rows and is reported as unavailable rather than deleted, so an Agent that already pinned it keeps working.

### Publishing and the gate

- [Publish (Skill)](../../CONTEXT.md) validates the submitted tree and freezes it as the next Version in one transaction; failing validation writes nothing and returns the findings to the caller. Both the Store form and the [Skill & Agent Builder](../../CONTEXT.md) reach the same service, and the Builder's pod carries an offline copy of the gate cut from these same sources at image build time, so what it reports before spending a call is what the API reports.
- The gate answers in two tiers. **Errors** refuse the publish: a missing or unparsable `SKILL.md` frontmatter block, a `name` outside `^[a-z0-9]+(-[a-z0-9]+)*$` or over 64 characters or disagreeing with the directory, a `description` over 1024 characters, a frontmatter key outside `name`, `description`, `license`, `metadata` and `allowed-tools`, more than 200 files, a file over 1 MiB, a tree over 5 MiB, invisible Unicode, and anything matching a known secret shape.
- **Lints** are recorded on the Version and never block: a `SKILL.md` body over 500 lines, a description under 20 words, a reference more than three directories deep, and a link to a file the tree does not hold.
- `allowed-tools` is stripped from the stored tree rather than refused, because tool policy belongs to the pod and not to a Skill.
- Two facts are derived once and stored on the Version: `has_executables`, true when any file is executable or sits under `scripts/`, and the content hash the delivery writer compares against.
- A Version's tree round-trips as a `.skill` archive — a zip of the tree with `0755` on executables and `0644` elsewhere, sorted by path — which is how a Skill crosses Organizations. Import refuses absolute or traversing paths and re-runs the gate.

### On an Agent

- [Agent Skills](../../CONTEXT.md) hang off an [Agent Profile](../../CONTEXT.md) as `agent_profile_skills` rows, each a foreign key to one immutable `skill_version_id`, so a pin never moves on its own. **[Update available](../../CONTEXT.md)** is the comparison of that pin against the Skill's newest Version, shown as a badge; upgrading is a deliberate act on one Agent's one Skill ([ADR-0059](../adr/0059-skills-exist-only-as-published-versions-and-a-built-in-agents-skills-live-on-a-development-profile.md)).
- A public or Built-in Agent may not carry a private Skill: the rule is enforced when a Skill is added, when an Agent's Visibility is widened, and at Publish (Agent).
- What reaching a workspace means, and when, is [Dynamic Delivery](dynamic-delivery.md).

### Retiring

- [Archive (Skill)](../../CONTEXT.md) flips a boolean: the Skill leaves the Store list and can be added to nothing new, while every Agent carrying it keeps its pinned Version. It is reversible from the Archived filter.
- [Delete (Skill)](../../CONTEXT.md) is permanent and refused while any Agent carries the Skill, naming those Agents as links; the UI offers **Archive instead** rather than failing.

## States

A Skill's place in its Organization's catalog.

| State | What happens |
|---|---|
| Private | Listed, pickable and editable for its creator alone; invisible to every other member |
| Public | Listed for the whole Organization; any permission holder may edit, archive or delete it |
| Archived | Out of the Store list and closed to new Agents; existing pins unaffected; reversible |
| Unavailable | A Built-in Skill whose name left the image — rows kept, offered to nothing new |
| Deleted | Rows and Versions gone; only reachable for an archived Skill no Agent carries |

## Edge cases

- When a publish submits content identical to the newest Version, no Version is minted and the existing one is returned.
- When two replicas reconcile the same Built-in Skill at once, an advisory lock per Skill makes them converge on one Version rather than two.
- When a Skill's name collides with one the workspace's package already owns, the package copy wins and the Organization's is recorded as omitted — see [Dynamic Delivery](dynamic-delivery.md).
- When an export is downloaded, it goes through a plain link with the Organization in the query string rather than a header, because a browser download sends no custom headers.
- When an imported archive holds an absolute or traversing path, the import is refused before anything is written.

## Code

- `backend/src/store/` — the catalog rows, the publish service, the Built-in Skill reconciler and the Store routes.
- `backend/src/store/gate/` — the validator, the frontmatter parser, the tree hash, the flags and the `.skill` archive.
- `agent-config/scripts/generate-validate-skill.mjs` — cuts the Builder's offline validator from those gate sources so the two cannot drift.
- `frontend/src/pages/store/skill-page.tsx` — the Skill page: file tabs, version picker, export, archive and delete.

## Related

- [Custom Agents](custom-agents.md) — the Agent side of a pin, and the Visibility rule that binds the two.
- [Dynamic Delivery](dynamic-delivery.md) — how a pinned Skill reaches a workspace, and when.
- [Skill & Agent Builder](skill-agent-builder.md) — authoring a Skill by conversation.
- [Agent](agent.md) — the profile a Built-in Skill is reconciled from.
