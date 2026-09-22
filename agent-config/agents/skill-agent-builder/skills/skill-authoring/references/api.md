# The Skill calls, exactly

Every path below is relative to `$OPSIFORCE_API_URL`, and every call carries
`Authorization: Bearer $OPSIFORCE_API_KEY`. `scripts/api.sh` does both.

## What this pod may call

| Call | Effect |
|---|---|
| `GET /skills?filter=all\|built_in\|custom\|private&q=…` | everything you can see; no pagination |
| `GET /skills/{id}` | one Skill: `latestVersion`, `visibility`, `usedByAgentCount`, `flags` |
| `GET /skills/{id}/versions/{n}/files` | the stored tree of one Version |
| `POST /skills/validate` | the gate, writing nothing; 200 either way, read `valid` |
| `POST /skills` | create, private to the author, at Version 1 |
| `POST /skills/{id}/versions` | mint the next Version from a whole tree |
| `POST /skills/{id}/duplicate` | a private copy under a new name, frontmatter `name` rewritten for you |

## What it may not, and what to say instead

Make public, archive, restore, delete, rename, export `.skill`, import — **none of these are on this
pod's key**, by design. They live in the Store, where a human does them and can see what they affect.
When an author asks for one, say so in one line and tell them where: *"I can't make it public from
here — open it in the Store and use Make public."*

## Bodies

```sh
# create — name must equal the frontmatter name
sh scripts/api.sh call POST /skills @scratch/body.json
# body.json: {"name":"release-notes","displayName":"Release Notes","files":[{"path":"SKILL.md","content":"---\n…"}]}

# a new Version — files only, the name is already fixed
sh scripts/api.sh call POST "/skills/$ID/versions" @scratch/body.json
# body.json: {"files":[ … ]}

# duplicate a built-in to extend it
sh scripts/api.sh call POST "/skills/$ID/duplicate" '{"name":"house-release-notes"}'

# validate without writing
sh scripts/api.sh call POST /skills/validate @scratch/validate.json
# body.json: {"name":"release-notes","files":[ … ]}
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
| 409 | `name-unavailable` | the name is taken in this Organization, or the image ships it |
| 404 | `not-found` | no such Skill, or it is not visible to you |
| 403 | `forbidden` | a Skill you may see but not write — Duplicate it instead |
| 400 | `validation-error` | the request body itself is malformed, before any gate ran |

A 422 is a work list, not a dead end: fix what it names and resubmit. Run the local validator first
and you should never see one.
