# The Agent calls, exactly

Paths are relative to `$OPSIFORCE_API_URL`; `scripts/api.sh call` sends the bearer.

## What this pod may call

| Call | Effect |
|---|---|
| `GET /agents` | the pickable Agents; this Builder is deliberately absent from it |
| `GET /agents/{id}` | identity, settings, and **every** profile with its Skills, update flags and Template hash |
| `PATCH /agents/{id}` | set the one-line `description`, or `displayName` when the author asks for another name; the slug never changes |
| `PUT /agents/{id}/profile` | write the Development prompt body, model and variant — the whole body, replacing the previous one. `promptBody` and `model` are both required |
| `PUT /agents/{id}/template` | save: make the Development Template an exact mirror of `template/`. No body; only this chat may call it |
| `GET /agents/{id}/skills` | the Skills on Development, with `pinnedVersion` and `updateAvailable` |
| `PUT /agents/{id}/skills/{skillId}` | add or re-pin. `{}` pins the latest Version; `{"versionId":"…"}` pins a named one, from `GET /skills/{id}` |
| `DELETE /agents/{id}/skills/{skillId}` | remove |

## The calls

```sh
# the Agent this chat authors already exists
A=$(sh scripts/api.sh call GET /me | jq -r .builderSubject.id)

# say what it is for, once the brief is clear
sh scripts/api.sh call PATCH "/agents/$A" '{"description":"<one sentence: what the Agent does, from the brief>"}'

# write the Development profile: the whole body, every time, with the pair it already has
sh scripts/api.sh call GET "/agents/$A" | jq '.profiles[0] | {model, variant}' > scratch/pair.json
jq -Rn --rawfile body scratch/prompt.md --slurpfile pair scratch/pair.json \
   '$pair[0] + {promptBody:$body}' > scratch/profile.json
sh scripts/api.sh call PUT "/agents/$A/profile" @scratch/profile.json

# skills: add at latest, then read back what is pinned
sh scripts/api.sh call PUT "/agents/$A/skills/$SKILL_ID" '{}'
sh scripts/api.sh call GET "/agents/$A/skills"

# save the Template after its check; the answer lists the hash, files, skipped paths and warnings
sh scripts/api.sh call PUT "/agents/$A/template"

# read the Agent back before reporting
sh scripts/api.sh call GET "/agents/$A"
```

`GET /agents/{id}` returns one profile per Environment of the Organization, **Development first** —
`profiles[0]` — then the rest by Environment name. A profile whose `skills` is `null` is an Environment
this Agent has no profile at yet; those fill in when someone publishes from the Store, and they are
read-only here. `settings.defaultEnvironmentId` is the profile new Projects are created from; for a
new Agent it is Production, which has no profile until someone publishes. Each profile's `template`
is `{hash}` or `null`, so a Production hash that differs from Development's means Production is behind.

## Failures worth recognising

| Status | Problem | Meaning |
|---|---|---|
| 422 | `model-unknown` | the `model` is not in the deployment catalogue, or the `variant` is not one that model offers |
| 404 | `not-found` | no such Agent, or not visible to you |
| 403 | `forbidden` | an Agent this chat does not author — tell the author to open the Builder on that Agent |
| 400 | `validation-error` | the body itself is malformed |
| 422 | `template-refused` | every refused Template path is listed in `errors[]` with its reason; nothing was saved |
| 409 | `template-changed` | `template/` changed during the copy: stop whatever writes into it and save again |
