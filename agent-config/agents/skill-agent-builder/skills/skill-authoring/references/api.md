# The Skill calls, exactly

Every path below is relative to `$OPSIFORCE_API_URL`, and every call carries
`Authorization: Bearer $OPSIFORCE_API_KEY`. `scripts/api.sh` does both.

## What this pod may call

| Call | Effect |
|---|---|
| `GET /skills?filter=all\|built_in\|custom\|private&q=…` | everything you can see; no pagination |
| `GET /skills/{id}` | one Skill: `latestVersion`, `visibility`, `usedByAgentCount`, `flags` |
| `GET /skills/{id}/versions/{n}/files` | the stored tree of one Version |
| `PATCH /skills/{id}` | set `displayName` when the author asks for another name; `null` falls back to `name`, which never changes |
| `POST /skills/validate` | the gate, writing nothing; 200 either way, read `valid` |
| `POST /skills` | create a Skill the Agent you are writing needs, private to the author, at Version 1 — never the Skill this chat authors, which already exists |
| `POST /skills/{id}/versions` | mint the next Version from a whole tree — Version 1 too, for a Skill created without one |
| `POST /skills/{id}/duplicate` | a private copy under a new name, frontmatter `name` rewritten for you — how an Agent's chat varies a built-in or a Skill it may not write |

## Not on this pod's key

Besides what `agent.md` says this chat cannot do: exporting or importing a `.skill` archive. Both are
the Store's.

## Bodies

```sh
# create a Skill the Agent needs — name must equal the frontmatter name
sh scripts/api.sh call POST /skills @scratch/body.json
# body.json: {"name":"release-notes","displayName":"Release Notes","files":[{"path":"SKILL.md","content":"---\n…"}]}

# a new Version — files only, the name is already fixed
sh scripts/api.sh call POST "/skills/$ID/versions" @scratch/body.json
# body.json: {"files":[ … ]}

# vary a built-in for the Agent you are writing
sh scripts/api.sh call POST "/skills/$ID/duplicate" '{"name":"house-release-notes"}'

# validate without writing
sh scripts/api.sh call POST /skills/validate @scratch/validate.json
# validate.json: {"name":"release-notes","files":[ … ]}
```

`scripts/pack-skill.mjs --json <dir>` prints the body from a directory. Pass `--name` (and optionally
`--display-name`) for a **create**, and leave them off for a **new Version**, which refuses `name`:

```sh
node scripts/pack-skill.mjs --json scratch/release-notes --name release-notes > scratch/body.json
node scripts/pack-skill.mjs --json scratch/release-notes > scratch/version.json
```

A file is `{path, content}`, with `isBinary: true` when `content` is base64 and `executable: true`
for the executable bit. `--json` sets both for you.

## Failures worth recognising

Failures come back as RFC 9457 Problems — `application/problem+json` with a `type`, `title`, `status`
and `detail`.

| Status | Problem | Meaning |
|---|---|---|
| 422 | `validation-failed` | the gate refused; `errors[]` and `lints[]` carry `rule`, `file`, `line` — the same findings the local script prints |
| 409 | `name-unavailable` | the name is taken in this Organization, or the image ships it: choose a name that adds the Agent's slug, and tell the author the name you used. The same holds for a Duplicate's `name` |
| 404 | `not-found` | no such Skill, or it is not visible to you |
| 403 | `forbidden` | a Skill you may see but not write — Duplicate it and change the copy |
| 400 | `validation-error` | the request body itself is malformed, before any gate ran |

A 422 is a work list, not a dead end: fix what it names and resubmit. Run the local validator first
and you should never see one.
