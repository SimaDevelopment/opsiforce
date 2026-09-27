# Anatomy of a Skill

## The tree

```
release-notes/
  SKILL.md              required, at the root
  references/tone.md    loaded only when the body points at it
  references/api.md
  scripts/collect.sh    optional; a tool the agent runs; sets has_executables
  assets/template.md    optional; a format the agent fills in, never code it ships
```

`references/`, `scripts/` and `assets/` are conventions, not rules — the gate only cares about the
limits and about `SKILL.md` being at the root. Keep to them anyway: an author reading a Store row
recognises them, and `scripts/` is what raises `has_executables` for the person adding the Skill.

## Frontmatter

```yaml
---
name: release-notes
description: Use this skill when the user asks for release notes, a changelog entry or a summary of merged pull requests, including how to group changes and what tone to use.
---
```

- `name` — lowercase kebab-case, ≤ 64 characters, equal to the Skill's own name.
- `description` — required; the rest of this page is about it.
- `license`, `metadata` — allowed, rarely useful.
- `allowed-tools` — accepted and then **stripped**. The tool policy belongs to the pod.
- Nothing else. There is no extension point, and an unknown key is a refusal.

## Writing the description

It is the only part of the Skill the model sees without loading it, so it is not a title — it is a
trigger. Write it as *when to use this*, in the third person, twenty words or more.

The recipe: **"Use when …"** plus the words a user would actually say, plus the shape of the help.

> ❌ `Release notes helper`
> ❌ `This skill helps you write great release notes!`
> ✅ `Use when the user asks for release notes, a changelog entry or a summary of merged pull requests, including how to group changes by audience and what tone to use.`

Name the synonyms a real request would carry ("changelog", "what shipped", "summary of PRs"). Name the
adjacent thing it is *not* for, when confusion is likely ("not for commit messages"). Avoid `<` and
`>` — they are refused.

## Body versus references

The body is loaded whole, every time the skill fires. `references/` files are loaded only when the
body sends the model to one. So:

**Body** — what this is for; the handful of rules that are easy to get wrong; the shortest example
that actually runs; a pointer per reference file saying when to open it.

**References** — the full option table, the whole API surface, the alternative recipes, the
edge-case catalogue, the long worked examples.

A useful test: if a sentence would be true and useful in *every* task the skill fires on, it belongs
in the body. If it answers "what about X?", it belongs in a reference.

Point at references with a plain relative path so the link resolves and the `link_unresolved` lint
stays quiet:

```markdown
`references/tone.md` has the house voice and three worked examples.
```

## Writing for the reader

The reader is a model mid-task, not a person browsing. Four checks before you validate:

- **Lead with the trigger, not the topic.** The first line of the body answers "what do I do now that
  this fired?"; background, history and motivation go last or into a reference.
- **One idea per rule, stated once.** A rule that appears in the body and again in a reference will be
  followed from whichever copy the model read last. Say it where it is decided and point at it
  elsewhere.
- **Never restate what the reader already has.** The `platform` skill, the other Skills the Agent
  carries, and the model's own competence are all already in the room. A Skill earns its place by what
  only it knows.
- **Show the shortest thing that runs.** One worked example the model can copy beats three it has to
  adapt; put the variants in a reference.

## Versions

A Skill is a name and a stack of Versions. No Version is ever edited or replaced, and an Agent
carries a **pinned** Version — publishing a new one does not move any Agent onto it. So:

- publish a Version when something is genuinely better, not on every keystroke;
- tell the author the Version number, and that Agents already carrying the Skill stay where they are
  until someone upgrades them;
- for the Agent this chat writes, re-pin it yourself (`PUT /agents/{id}/skills/{skillId}` with `{}`),
  read the pin back, and refresh the Test Project by `agent-authoring`'s test loop §5 (a re-pin is a
  reset). Any other Project keeps the Skill it was created with.
