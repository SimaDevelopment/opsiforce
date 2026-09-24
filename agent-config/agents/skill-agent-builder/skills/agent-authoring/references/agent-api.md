# The Agent calls, exactly

Paths are relative to `$OPSIFORCE_API_URL`; `scripts/api.sh call` sends the bearer.

## What this pod may call

| Call | Effect |
|---|---|
| `GET /agents` | the pickable Agents; this Builder is deliberately absent from it |
| `GET /agents/{id}` | identity, settings, and **every** profile with its Skills and update flags |
| `PATCH /agents/{id}` | set the one-line `description`, or `displayName` when the author asks for another name; the slug never changes |
| `PUT /agents/{id}/profile` | write the Development prompt body, model and variant — the whole body, replacing the previous one. `promptBody` and `model` are both required |
| `GET /agents/{id}/skills` | the Skills on Development, with `pinnedVersion` and `updateAvailable` |
| `PUT /agents/{id}/skills/{skillId}` | add or re-pin. `{}` pins the latest Version; `{"versionId":"…"}` pins a named one, from `GET /skills/{id}` |
| `DELETE /agents/{id}/skills/{skillId}` | remove |

## The calls

```sh
# the Agent this chat authors already exists
A=$(sh scripts/api.sh call GET /me | jq -r .builderSubject.id)

# say what it is for, once the brief is clear
sh scripts/api.sh call PATCH "/agents/$A" '{"description":"Turns merged pull requests into release notes"}'

# write the Development profile: the whole body, every time, with the pair it already has
sh scripts/api.sh call GET "/agents/$A" | jq '.profiles[0] | {model, variant}' > scratch/pair.json
jq -Rn --rawfile body scratch/release-notes-writer.prompt.md --slurpfile pair scratch/pair.json \
   '$pair[0] + {promptBody:$body}' > scratch/profile.json
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

## Failures worth recognising

| Status | Problem | Meaning |
|---|---|---|
| 422 | `model-unknown` | the `model` is not in the deployment catalogue, or the `variant` is not one that model offers |
| 404 | `not-found` | no such Agent, or not visible to you |
| 403 | `forbidden` | an Agent this chat does not author — tell the author to open the Builder on that Agent |
| 400 | `validation-error` | the body itself is malformed |
