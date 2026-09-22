# Every gate rule

`scripts/validate-skill.mjs` is a generated copy of the platform's gate, so these are exactly the
findings `POST /skills`, `POST /skills/{id}/versions` and `POST /skills/validate` answer. Each finding
carries `rule`, `message`, `file` and `line`; the `rule` id is stable and safe to branch on.

## Limits

| Limit | Value |
|---|---|
| Files in one Skill | 200 |
| Bytes per file | 1 MiB |
| Bytes per Skill | 5 MiB |
| `name` | ≤ 64 characters, lowercase kebab-case |
| `description` | ≤ 1024 characters, no `<` or `>` |
| `SKILL.md` body | 500 lines (a lint, not a refusal) |
| `references/` link depth | 3 directories (a lint) |

## ERRORS — the write is refused

### Structure

| Rule | What tripped it | Fix |
|---|---|---|
| `file_count` | more than 200 files | split the Skill, or drop what nobody loads |
| `size_file` | one file over 1 MiB | move the bulk into `references/`, or leave it out |
| `size_total` | the tree over 5 MiB | the same; a Skill is instructions, not a data set |
| `duplicate_path` | two entries for one path | a packing bug — rebuild the tree |
| `symlink_entry` | a symlink in the tree | replace it with the file itself |
| `path_traversal` | absolute path, `..`, backslash or empty segment | use plain relative paths under the Skill root |

### Content

| Rule | What tripped it | Fix |
|---|---|---|
| `invisible_unicode` | a zero-width, bidirectional or tag character | delete it; it is either a paste artefact or a prompt-injection carrier |
| `secret_detected` | an AWS key id, GitHub/Slack token or a `BEGIN … PRIVATE KEY` block | remove it and tell the author it was there. A Skill is readable by the whole Organization once public; secrets belong in `opsiforce.env.json` |

### `SKILL.md` and its frontmatter

| Rule | What tripped it | Fix |
|---|---|---|
| `skill_md_missing` | no `SKILL.md` at the root | it must be at the root, not in a subdirectory |
| `frontmatter_missing` | the file does not open with `---` | frontmatter first, no blank line before it |
| `frontmatter_unparsable` | the block never closes | close it with `---` |
| `frontmatter_duplicate_key` | a key twice | keep one |
| `frontmatter_unknown_key` | a key outside `name`, `description`, `license`, `metadata`, `allowed-tools` | remove it; there is no extension point |
| `name_missing` / `name_length` / `name_format` | absent, over 64 characters, not lowercase kebab-case | rename |
| `name_mismatch` | frontmatter `name` ≠ the Skill being written | they are one identity; fix the file, not the request |
| `name_reserved` | a name the agent image ships (`platform`, `sqlite`, `ui`, …) | choose another; Duplicate the built-in instead of shadowing it |
| `description_missing` / `description_length` | absent, or over 1024 characters | write one; see the recipe in `skill-anatomy.md` |
| `description_angle_brackets` | `<` or `>` in the description | rewrite without them |

## LINTS — advice, never a refusal

| Rule | What tripped it | Why it matters |
|---|---|---|
| `body_too_long` | body over 500 lines | the whole body enters the context on load; move the tail into `references/` |
| `description_too_short` | under 20 words | the description is the only trigger — a short one either never fires or fires on everything |
| `allowed_tools_present` | an `allowed-tools` key | platform-owned, and **stripped from the stored file**; the tool policy is the pod's, not a Skill's |
| `link_unresolved` | a `references/…` path that is not in the tree | the model will follow it and find nothing |
| `link_too_deep` | nested more than 3 directories | flatten it |

## Flags

Alongside the findings the gate reports `flags`, which the Store shows to whoever adds the Skill:

- `has_executables` — any file carries the executable bit, or lives under `scripts/`.

It does not block a publish. It is visible, so say what is in it: a Skill that ships a script is a
fine thing, and a surprise is not.
