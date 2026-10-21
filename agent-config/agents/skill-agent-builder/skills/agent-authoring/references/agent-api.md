# The Agent calls, exactly

Every call is `scripts/api.sh <METHOD> <path> [json]`, on the terms `service-public-api` sets; the
Agent's id goes in the path, the fields in the JSON body.

## What this chat may call

| Call | Body | Effect |
|---|---|---|
| `GET /agents?limit=&cursor=` | | the pickable Agents; this Builder is deliberately absent from it |
| `GET /agents/<id>` | | identity, settings, and **every** profile with its Skills, update flags and Template hash |
| `PATCH /agents/<id>` | `{description?, displayName?}` | set the one-line `description`, or `displayName` when the author asks for another name; the slug never changes |
| `PUT /agents/<id>/profile` | `{promptBody, model, variant?}` | write the Development prompt body, model and variant — the whole body, replacing the previous one. `promptBody` and `model` are both required |
| `PUT /agents/<id>/template` | | save: make the Development Template an exact mirror of `template/`. Only this chat may call it |
| `GET /agents/<id>/skills` | | the Skills on Development, with `pinnedVersion` and `updateAvailable` |
| `PUT /agents/<id>/skills/<skillId>` | `{versionId?}` | add or re-pin. No `versionId` pins the latest Version; a `versionId` from `GET /skills/<id>` pins that one |
| `DELETE /agents/<id>/skills/<skillId>` | | remove |

Reads reach every Agent the author can see; writes reach only the Agent this chat authors and Agents
this chat created. Writes need *Edit Agents and Skills*, which a new chat has on.

## The calls

```sh
# the Agent this chat authors already exists
A=$(sh scripts/api.sh GET /me | jq -r .builderSubject.id)

# say what it is for, once the brief is clear
sh scripts/api.sh PATCH "/agents/$A" '{"description":"<one sentence: what the Agent does, from the brief>"}'

# write the Development profile: the whole body, every time, with the pair it already has
sh scripts/api.sh GET "/agents/$A" | jq '.profiles[0] | {model, variant}' > scratch/pair.json
jq -Rn --rawfile body scratch/prompt.md --slurpfile pair scratch/pair.json \
   '$pair[0] + {promptBody: $body}' > scratch/profile.json
sh scripts/api.sh PUT "/agents/$A/profile" @scratch/profile.json

# skills: add at latest, then read back what is pinned
sh scripts/api.sh PUT "/agents/$A/skills/$SKILL_ID" '{}'
sh scripts/api.sh GET "/agents/$A/skills"

# save the Template after its check; the answer lists the hash, files, skipped paths and warnings
sh scripts/api.sh PUT "/agents/$A/template"

# read the Agent back before reporting
sh scripts/api.sh GET "/agents/$A"
```

`GET /agents/<id>` returns one profile per Environment of the Organization, **Development first** —
`profiles[0]` — then the rest by Environment name. A profile whose `skills` is `null` is an Environment
this Agent has no profile at yet; those fill in when someone publishes from the Store, and they are
read-only here. `settings.defaultEnvironmentId` is the profile new Projects are created from; for a
new Agent it is Production, which has no profile until someone publishes. Each profile's `template`
is `{hash}` or `null`, so a Production hash that differs from Development's means Production is behind.

## Failures worth recognising

Beside the refusals `service-public-api` lists, an Agent call answers these `type` slugs:

| `type` slug | Meaning |
|---|---|
| `model-unknown` | the `model` is not in the deployment catalogue, or the `variant` is not one that model offers |
| `not-found` | no such Agent, or not visible to you |
| `forbidden`, `permission-denied` | an Agent this chat does not author and did not create — tell the author to open the Builder on that Agent |
| `validation-error` | the body itself is malformed |
| `template-refused` | every refused Template path is listed in `errors[]` with its reason; nothing was saved |
| `template-changed` | `template/` changed during the copy: stop whatever writes into it and save again |
