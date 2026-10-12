# The Skill calls, exactly

Every call below is a `public-api` Operation: `scripts/api.sh call <operation> [input]` POSTs the input
to `$EXTERNAL_SERVICES_URL/public-api/<operation>` with `Authorization: Bearer $SERVICE_GATEWAY_API_KEY`,
the platform skill's `callService` in shell. The input is one flat JSON object: the ids a route used
to take in its path, its query parameters and its body fields side by side.

## What this chat may call

| Operation | Input | Effect |
|---|---|---|
| `list_skills` | `{filter?: "all"\|"built_in"\|"custom"\|"private", q?}` | everything you can see; no pagination |
| `get_skill` | `{id}` | one Skill: `latestVersion`, `visibility`, `usedByAgentCount`, `flags` |
| `get_skill_files` | `{id, version}` | the stored tree of one Version |
| `update_skill` | `{id, displayName}` | set `displayName` when the author asks for another name; `null` falls back to `name`, which never changes |
| `validate_skill` | `{name?, files}` | the gate, writing nothing; answers either way, read `valid` |
| `create_skill` | `{name, displayName?, files}` | create a Skill the Agent you are writing needs, private to the author, at Version 1 — never the Skill this chat authors, which already exists |
| `create_skill_version` | `{id, files}` | mint the next Version from a whole tree — Version 1 too, for a Skill created without one |
| `duplicate_skill` | `{id, name, displayName?}` | a private copy under a new name, frontmatter `name` rewritten for you — how an Agent's chat varies a built-in or a Skill it may not write |

Reads reach every Skill the author can see. Writes reach only this chat's own Skill and the Skills
this chat created; a Duplicate is created by this chat, so it is writable.

## Not on this chat's list

Besides what `agent.md` says this chat cannot do: exporting or importing a `.skill` archive. Both are
the Store's.

## Inputs

```sh
# create a Skill the Agent needs — name must equal the frontmatter name
sh scripts/api.sh call create_skill @scratch/body.json
# body.json: {"name":"release-notes","displayName":"Release Notes","files":[{"path":"SKILL.md","content":"---\n…"}]}

# a new Version — the Skill's id and the files; the name is already fixed
sh scripts/api.sh call create_skill_version @scratch/body.json
# body.json: {"id":"<skill id>","files":[ … ]}

# vary a built-in for the Agent you are writing
sh scripts/api.sh call duplicate_skill "$(jq -cn --arg id "$ID" '{id: $id, name: "house-release-notes"}')"

# validate without writing
sh scripts/api.sh call validate_skill @scratch/validate.json
# validate.json: {"name":"release-notes","files":[ … ]}
```

`scripts/pack-skill.mjs --json <dir>` prints the files from a directory. Pass `--name` (and optionally
`--display-name`) for a **create**; for a **new Version**, leave them off and add the Skill's `id`:

```sh
node scripts/pack-skill.mjs --json scratch/release-notes --name release-notes > scratch/body.json
node scripts/pack-skill.mjs --json scratch/release-notes | jq --arg id "$ID" '. + {id: $id}' > scratch/version.json
```

A file is `{path, content}`, with `isBinary: true` when `content` is base64 and `executable: true`
for the executable bit. `--json` sets both for you.

## Failures worth recognising

A refusal is `application/problem+json` with a `code`. A refusal of the Public API itself keeps its
`code` and `detail`.

| `code` | Meaning |
|---|---|
| `validation-failed` | the gate refused; `errors[]` and `lints[]` carry `rule`, `file`, `line` — the same findings the local script prints |
| `name-unavailable` | the name is taken in this Organization, or the image ships it: choose a name that adds the Agent's slug, and tell the author the name you used. The same holds for a Duplicate's `name` |
| `not-found` | no such Skill, or it is not visible to you |
| `forbidden`, `permission-denied` | a Skill you may see but not write: the author may not edit it, or it is neither this chat's Skill nor one this chat created — Duplicate it and change the copy |
| `operation-off` | the author switched this Operation off for this chat under External services, below the chat; say so, and do not retry |
| `invalid-input` | the input itself is malformed, before any gate ran |

A `validation-failed` is a work list, not a dead end: fix what it names and resubmit. Run the local
validator first and you should never see one.
