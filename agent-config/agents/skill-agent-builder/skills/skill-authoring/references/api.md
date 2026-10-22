# The Skill calls, exactly

Every call below is `scripts/api.sh <METHOD> <path> [json]`, on the terms `service-public-api` sets.
Ids go in the path, filters in the query, the rest in the JSON body.

## What this chat may call

| Call | Body | Effect |
|---|---|---|
| `GET /skills?filter=all\|built_in\|custom\|private&q=` | | everything you can see; no pagination |
| `GET /skills/<id>` | | one Skill: `latestVersion`, `visibility`, `usedByAgentCount`, `flags` |
| `GET /skills/<id>/versions/<version>/files` | | the stored tree of one Version |
| `PATCH /skills/<id>` | `{displayName}` | set `displayName` when the author asks for another name; `null` falls back to `name`, which never changes |
| `POST /skills/validate` | `{name?, files}` | the gate, writing nothing; answers either way, read `valid` |
| `POST /skills` | `{name, displayName?, files}` | create a Skill the Agent you are writing needs, private to the author, at Version 1 — never the Skill this chat authors, which already exists |
| `POST /skills/<id>/versions` | `{files}` | mint the next Version from a whole tree — Version 1 too, for a Skill created without one |
| `POST /skills/<id>/duplicate` | `{name, displayName?}` | a private copy under a new name, frontmatter `name` rewritten for you — how an Agent's chat varies a built-in or a Skill it may not write |

Reads reach every Skill the author can see. Writes reach only this chat's own Skill and the Skills
this chat created; a Duplicate is created by this chat, so it is writable. Writes need *Edit Agents
and Skills*, which a new chat has on.

## Not on this chat's list

Besides what `agent.md` says this chat cannot do: exporting or importing a `.skill` archive. Both are
the Store's.

## Bodies

```sh
# create a Skill the Agent needs — name must equal the frontmatter name
sh scripts/api.sh POST /skills @scratch/body.json
# body.json: {"name":"release-notes","displayName":"Release Notes","files":[{"path":"SKILL.md","content":"---\n…"}]}

# a new Version — the Skill's id in the path, the files in the body; the name is already fixed
sh scripts/api.sh POST "/skills/$ID/versions" @scratch/version.json
# version.json: {"files":[ … ]}

# vary a built-in for the Agent you are writing
sh scripts/api.sh POST "/skills/$ID/duplicate" '{"name":"house-release-notes"}'

# validate without writing
sh scripts/api.sh POST /skills/validate @scratch/validate.json
# validate.json: {"name":"release-notes","files":[ … ]}
```

`scripts/pack-skill.mjs --json <dir>` prints the files from a directory. Pass `--name` (and optionally
`--display-name`) for a **create**; for a **new Version**, leave them off:

```sh
node scripts/pack-skill.mjs --json scratch/release-notes --name release-notes > scratch/body.json
node scripts/pack-skill.mjs --json scratch/release-notes > scratch/version.json
```

A file is `{path, content}`, with `isBinary: true` when `content` is base64 and `executable: true`
for the executable bit. `--json` sets both for you.

## Failures worth recognising

Beside the refusals `service-public-api` lists, a Skill call answers these `type` slugs:

| `type` slug | Meaning |
|---|---|
| `validation-failed` | the gate refused; `errors[]` and `lints[]` carry `rule`, `file`, `line` — the same findings the local script prints |
| `name-unavailable` | the name is taken in this Organization, or the image ships it: choose a name that adds the Agent's slug, and tell the author the name you used. The same holds for a Duplicate's `name` |
| `not-found` | no such Skill, or it is not visible to you |
| `forbidden`, `permission-denied` | a Skill you may see but not write: the author may not edit it, or it is neither this chat's Skill nor one this chat created — Duplicate it and change the copy |
| `validation-error` | the body itself is malformed, before any gate ran |

A `validation-failed` is a work list, not a dead end: fix what it names and resubmit. Run the local
validator first and you should never see one.
