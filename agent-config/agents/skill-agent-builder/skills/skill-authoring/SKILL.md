---
name: skill-authoring
description: Skill authoring — whether one is warranted, the frontmatter and its triggering description, the body and references split, and the validate, publish, read-back loop. Load it before drafting, validating or publishing a Skill.
---

# Authoring a Skill

A **Skill** is a directory the runtime lays into a workspace as `.opencode/skills/<name>/`. The agent
carrying it sees only the `name` and `description` until a task matches; then it loads `SKILL.md`, and
only then whatever that file points at. Everything about authoring follows from that: the description
decides *whether* the skill is ever read, the body decides what happens when it is, and `references/`
carries the rest at no standing cost.

## Is a Skill warranted?

In an Agent chat this decides whether to create one; in a Skill chat, name the catch-all you found and
carry on unless the author stops you.

Yes, when the guidance is **reusable** (it will apply in chats nobody has had yet), **non-obvious**
(the model gets it wrong or inconsistent without it), and **stable** (it is not this week's one-off).
A house API's auth dance, a library's version-specific idiom, a reporting format with real rules.

No, when it is:

- a **one-off instruction** — say it in the chat, or put it in the Agent's prompt;
- something the model already does well — a skill that restates common knowledge only adds a trigger
  that misfires;
- **anything the `platform` skill covers** — every agent already carries it;
- already in the **built-in catalogue** — check first (below).

Offer the author the honest answer, including "this does not need a Skill".

## Check the catalogue first, then offer reuse, extend or fresh

Before drafting anything, list what already exists and read the closest match:

```sh
sh /workspace/scripts/api.sh call GET '/skills?filter=built_in'
sh /workspace/scripts/api.sh call GET '/skills?q=release'
sh /workspace/scripts/api.sh call GET "/skills/$ID"                       # its latest version number is here
sh /workspace/scripts/api.sh call GET "/skills/$ID/versions/$N/files"      # read that one, or the one an Agent pins — never assume 1
```

Then decide, and say which you did:

| Path | When | How |
|---|---|---|
| **Reuse** | an existing Skill already does it | add it to the Agent — no new Skill at all. In a Skill's chat, tell the author which one already covers it |
| **Extend** | close, but needs house specifics | in an Agent's chat, `POST /skills/{id}/duplicate {"name":"…"}` → a private copy under a new name, then publish a Version onto it and add it. In a Skill's chat, read its files and publish them, changed, as a Version of this chat's Skill |
| **Fresh** | nothing close | draft in `scratch/<name>/` |

Put the choice to the author only when Reuse and Extend are both plausible and the brief does not say
which; with nothing close, draft. Duplicate works from a built-in row, and the copy is private to the
author. It is the only honest way to "edit a built-in": the built-in itself is image-owned and cannot
be changed.

## The authoring loop

Draft, validate offline, publish, read back — in one pass, once the tree validates.

```sh
# 1. draft under scratch/<name>/ — SKILL.md plus any references/
# 2. the same gate the API runs, offline:
node /workspace/scripts/validate-skill.mjs scratch/release-notes --name release-notes
# 3. publish a Version onto the Skill — files alone, no --name, which that route refuses:
node /workspace/scripts/pack-skill.mjs --json scratch/release-notes > scratch/body.json
sh /workspace/scripts/api.sh call POST "/skills/$ID/versions" @scratch/body.json
# only a new Skill an Agent needs is created instead, with its name:
# node /workspace/scripts/pack-skill.mjs --json scratch/release-notes --name release-notes > scratch/body.json
# sh /workspace/scripts/api.sh call POST /skills @scratch/body.json
# 4. read back what landed, and say the Version number to the author:
sh /workspace/scripts/api.sh call GET "/skills/$ID/versions/$N/files"
```

**Every submission is a whole tree.** A Version is minted from the files you send, and nothing is
merged with the Version before it. To change one line, send every file again with that line changed —
fetch the current files first if you did not write them.

## ERRORS block, LINTS do not

The gate answers two lists, and they mean different things:

- **ERRORS** — the write is refused. Fix every one yourself, before you publish.
- **LINTS** — advice that never blocks: a body over 500 lines, a description under 20 words, a
  `references/` link that resolves nowhere, `allowed-tools` (platform-owned, and silently stripped).
  Fix them anyway unless the author has a reason, because each one names a real way the skill will
  underperform. Tell the author what you fixed rather than pasting the rule ids.

`references/gate-rules.md` has every rule, what triggers it and what to do about it.

## Frontmatter, description, body, references

`SKILL.md` sits at the root: YAML frontmatter with `name` and `description` (optionally `license` and
`metadata`; `allowed-tools` is stripped, any other key refused), then the body. The **description is
the trigger** — write it as *when to use this*, in the user's words. The **body** is the decision
layer; long tables, API surfaces, variants and edge cases go in `references/<topic>.md`.

Files the author uploads arrive in `/workspace/user_uploaded_files/`. Extract what the agent needs
into `references/<topic>.md`; a file the child must open as it is (a PDF, a font, a sheet) belongs in
an Agent's Template.

A Skill frames work: decisions, contracts, conventions, libraries and short examples —
never an implementation for the agent to copy into what it builds. `scripts/` holds tools the agent
runs, not code an App ships. For a stack Skill an Agent carries, `agent-authoring` has the frame.

`references/skill-anatomy.md` has the full contract, the description recipe and the body/references
split with examples; `references/api.md` has every call this loop makes, with bodies and Problem
shapes.

## Reporting to the author

Name the Skill, its Version, and its visibility in plain language: a new Skill is **private to you**
until someone makes it public from the Store. Say what it does and what you fixed on the way. Give
the tree as a one-line summary and its path.
