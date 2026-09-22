---
name: skill-authoring
description: How to author a Skill for the Opsiforce Store — when one is warranted at all, what the SKILL.md frontmatter must carry, why the description is the only trigger, what belongs in references instead of the body, and the offline-validate then publish then read-back loop against the platform API. Load it before drafting, validating or publishing any Skill.
---

# Authoring a Skill

A **Skill** is a directory the runtime lays into a workspace as `.opencode/skills/<name>/`. The agent
carrying it sees only the `name` and `description` until a task matches; then it loads `SKILL.md`, and
only then whatever that file points at. Everything about authoring follows from that: the description
decides *whether* the skill is ever read, the body decides what happens when it is, and `references/`
carries the rest at no standing cost.

## Is a Skill warranted?

Yes, when the guidance is **reusable** (it will apply in chats nobody has had yet), **non-obvious**
(the model gets it wrong or inconsistent without it), and **stable** (it is not this week's one-off).
A house API's auth dance, a library's version-specific idiom, a reporting format with real rules.

No, when it is:

- a **one-off instruction** — say it in the chat, or put it in the Agent's prompt;
- something the model already does well — a skill that restates common knowledge only adds a trigger
  that misfires;
- **anything the `platform` skill covers** — the App contract, `$APP_PORT`, `app.meta.json`, uploads
  and generated files, `opsiforce.env.json`, the platform environment variables, the LLM gateway, the
  two read-only databases. Every agent already has `platform`. Never copy a line of it;
- already in the **built-in catalogue** — check first (below).

Offer the author the honest answer, including "this does not need a Skill".

## Check the catalogue first, then offer reuse, extend or fresh

Before drafting anything, list what already exists and read the closest match:

```sh
sh /workspace/scripts/api.sh call GET '/skills?filter=built_in'
sh /workspace/scripts/api.sh call GET '/skills?q=release'
sh /workspace/scripts/api.sh call GET "/skills/$ID/versions/1/files"
```

Then put three options to the author in plain language:

| Offer | When | How |
|---|---|---|
| **Reuse** | an existing Skill already does it | add it to the Agent — no new Skill at all |
| **Extend** | close, but needs house specifics | `POST /skills/{id}/duplicate {"name":"…"}` → a private copy under a new name, then publish a Version onto it |
| **Fresh** | nothing close | draft in `scratch/` |

Duplicate works from a built-in row, and the copy is private to the author's Organization. It is the
only honest way to "edit a built-in": the built-in itself is image-owned and cannot be changed.

## The authoring loop

Draft, validate offline, publish, read back. Never publish blind and never claim a publish you did
not read back.

```sh
# 1. draft under scratch/<name>/ — SKILL.md plus any references/
# 2. the same gate the API runs, offline:
node /workspace/scripts/validate-skill.mjs scratch/release-notes --name release-notes
# 3. publish (a new Skill, or a Version onto one that exists):
node /workspace/scripts/pack-skill.mjs --json scratch/release-notes --name release-notes > scratch/body.json
sh /workspace/scripts/api.sh call POST /skills @scratch/body.json
# a Version onto a Skill that exists takes the files alone — no --name, which that route refuses:
# node /workspace/scripts/pack-skill.mjs --json scratch/release-notes > scratch/body.json
# sh /workspace/scripts/api.sh call POST "/skills/$ID/versions" @scratch/body.json
# 4. read back what landed, and say the Version number to the author:
sh /workspace/scripts/api.sh call GET "/skills/$ID/versions/$N/files"
```

`POST /skills/validate` exists for the same check server-side; prefer the local script — it is a
generated copy of the platform's gate, so the findings are the same and cost nothing.

**Every submission is a whole tree.** A Version is minted from the files you send, and nothing is
merged with the Version before it. To change one line, send every file again with that line changed —
fetch the current files first if you did not write them.

**A Skill's `name` is immutable**, is the directory the runtime loads it under, and must equal the
frontmatter `name`. Names the agent image already ships (`platform`, `sqlite`, `ui`, …) are refused.
Only `displayName` and content can change afterwards.

## ERRORS block, LINTS do not

The gate answers two lists, and they mean different things:

- **ERRORS** — the write is refused. Fix every one; do not argue with them or ask the author to
  approve a workaround.
- **LINTS** — advice that never blocks: a body over 500 lines, a description under 20 words, a
  `references/` link that resolves nowhere, `allowed-tools` (platform-owned, and silently stripped).
  Fix them anyway unless the author has a reason, because each one names a real way the skill will
  underperform. Tell the author what you fixed rather than pasting the rule ids.

`references/gate-rules.md` has every rule, what triggers it and what to do about it.

## Frontmatter, description, body, references

The contract in one line: `SKILL.md` at the root, YAML frontmatter with `name` and `description`
(`license` and `metadata` optional; nothing else allowed), then the body.

The **description is the trigger** — the only part the model reads without loading the skill. Write
it as *when to use this*, naming the words a user would actually say, in the third person, twenty
words or more. "Use when the user asks for release notes, a changelog or a summary of merged pull
requests" beats "Release notes helper".

Keep the **body** the decision layer: what this is for, the rules that are easy to get wrong, the
shortest worked example. Push long tables, full API surfaces, alternative recipes and edge-case
catalogues into `references/<topic>.md` and link them from the body, so they load only when needed.

`references/skill-anatomy.md` has the full contract, a description recipe and the body/references
split with examples; `references/api.md` has every call this loop makes, with bodies and Problem
shapes.

## Reporting to the author

Name the Skill, its Version, and its visibility in plain language: a new Skill is **private to you**
until someone makes it public from the Store — and this chat cannot make it public. Say what it does
and what you fixed on the way. Never paste the whole tree back at them.
