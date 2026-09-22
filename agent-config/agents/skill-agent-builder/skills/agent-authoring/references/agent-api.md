# The Agent calls, exactly

Paths are relative to `$OPSIFORCE_API_URL`; `scripts/api.sh call` sends the bearer.

## What this pod may call

| Call | Effect |
|---|---|
| `GET /agents` | the pickable Agents; this Builder is deliberately absent from it |
| `GET /agents/{id}` | identity, settings, and **every** profile with its Skills and update flags |
| `POST /agents` | create a Custom Agent, private to the author, with a Development profile |
| `PUT /agents/{id}/profile` | write the Development prompt body, model and variant — the whole body, replacing the previous one. `promptBody` and `model` are both required, so send the pair the Agent already has when you are only changing the prose |
| `GET /agents/{id}/skills` | the Skills on Development, with `pinnedVersion` and `updateAvailable` |
| `PUT /agents/{id}/skills/{skillId}` | add or re-pin. `{}` pins the latest Version; `{"versionId":"…"}` pins a named one, from `GET /skills/{id}` |
| `DELETE /agents/{id}/skills/{skillId}` | remove |
| `POST /agents/{id}/duplicate` | a private copy under a new display name |

## What it may not

Publish to an Environment, change visibility, archive, restore, delete, or write settings. Those are
the **Store's**, done by a person who can see the blast radius. Say that in one line and move on.

## The calls

```sh
# create — omit model to take the platform's default pair
A=$(sh scripts/api.sh call POST /agents \
      '{"displayName":"Release Notes Writer","description":"Turns merged pull requests into release notes"}' \
      | jq -r .id)

# write the Development profile: the whole body, every time
jq -Rn --rawfile body scratch/release-notes-writer.prompt.md \
   '{promptBody:$body, model:"openai/gpt-5.6-sol", variant:"high"}' > scratch/profile.json
sh scripts/api.sh call PUT "/agents/$A/profile" @scratch/profile.json

# skills: add at latest, then read back what is pinned
sh scripts/api.sh call PUT "/agents/$A/skills/$SKILL_ID" '{}'
sh scripts/api.sh call GET "/agents/$A/skills"

# read the Agent back before reporting
sh scripts/api.sh call GET "/agents/$A"
```

`GET /agents/{id}` returns one profile per Environment of the Organization, **Development first** —
`profiles[0]` — then the rest by Environment name. A profile whose `skills` is `null` is an Environment
this Agent has no profile at yet; those fill in when someone publishes from the Store, and they are
read-only here. `settings.defaultEnvironmentId` is the profile new Projects are created from.

`displayName` fixes the slug and the slug cannot change afterwards, so get the name right before
creating — ask the author rather than guessing a name they will want to change.

## Failures worth recognising

| Status | Problem | Meaning |
|---|---|---|
| 422 | `model-unknown` | the `model` is not in the deployment catalogue, or the `variant` is not one that model offers |
| 409 | `name-unavailable` | the display name's slug is taken in this Organization |
| 404 | `not-found` | no such Agent, or not visible to you |
| 403 | `forbidden` | someone else's Agent — Duplicate it instead |
| 400 | `validation-error` | the body itself is malformed |

An Agent is only pickable once its Development profile exists, so create and then write the profile
before telling the author it is ready.
