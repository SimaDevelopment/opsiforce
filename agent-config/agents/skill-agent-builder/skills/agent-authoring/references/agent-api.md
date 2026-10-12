# The Agent calls, exactly

Every call is a `public-api` Operation through `scripts/api.sh call <operation> [input]`, which sends
the service key; the input is one flat JSON object (the Agent's `id`, then the body fields).

## What this chat may call

| Operation | Input | Effect |
|---|---|---|
| `list_agents` | `{limit?, cursor?}` | the pickable Agents; this Builder is deliberately absent from it |
| `get_agent` | `{id}` | identity, settings, and **every** profile with its Skills, update flags and Template hash |
| `update_agent` | `{id, description?, displayName?}` | set the one-line `description`, or `displayName` when the author asks for another name; the slug never changes |
| `update_agent_profile` | `{id, promptBody, model, variant?}` | write the Development prompt body, model and variant — the whole body, replacing the previous one. `promptBody` and `model` are both required |
| `save_agent_template` | `{id}` | save: make the Development Template an exact mirror of `template/`. Only this chat may call it |
| `list_agent_skills` | `{id}` | the Skills on Development, with `pinnedVersion` and `updateAvailable` |
| `set_agent_skill` | `{id, skillId, versionId?}` | add or re-pin. No `versionId` pins the latest Version; a `versionId` from `get_skill` pins that one |
| `remove_agent_skill` | `{id, skillId}` | remove |

Reads reach every Agent the author can see; writes reach only the Agent this chat authors and Agents
this chat created.

## The calls

```sh
# the Agent this chat authors already exists
A=$(sh scripts/api.sh call get_me | jq -r .builderSubject.id)
agent() { jq -cn --arg id "$A" '{id: $id}'; }

# say what it is for, once the brief is clear
sh scripts/api.sh call update_agent "$(jq -cn --arg id "$A" '{id: $id, description: "<one sentence: what the Agent does, from the brief>"}')"

# write the Development profile: the whole body, every time, with the pair it already has
sh scripts/api.sh call get_agent "$(agent)" | jq '.profiles[0] | {model, variant}' > scratch/pair.json
jq -Rn --rawfile body scratch/prompt.md --slurpfile pair scratch/pair.json --arg id "$A" \
   '$pair[0] + {id: $id, promptBody: $body}' > scratch/profile.json
sh scripts/api.sh call update_agent_profile @scratch/profile.json

# skills: add at latest, then read back what is pinned
sh scripts/api.sh call set_agent_skill "$(jq -cn --arg id "$A" --arg s "$SKILL_ID" '{id: $id, skillId: $s}')"
sh scripts/api.sh call list_agent_skills "$(agent)"

# save the Template after its check; the answer lists the hash, files, skipped paths and warnings
sh scripts/api.sh call save_agent_template "$(agent)"

# read the Agent back before reporting
sh scripts/api.sh call get_agent "$(agent)"
```

`get_agent` returns one profile per Environment of the Organization, **Development first** —
`profiles[0]` — then the rest by Environment name. A profile whose `skills` is `null` is an Environment
this Agent has no profile at yet; those fill in when someone publishes from the Store, and they are
read-only here. `settings.defaultEnvironmentId` is the profile new Projects are created from; for a
new Agent it is Production, which has no profile until someone publishes. Each profile's `template`
is `{hash}` or `null`, so a Production hash that differs from Development's means Production is behind.

## Failures worth recognising

| `code` | Meaning |
|---|---|
| `model-unknown` | the `model` is not in the deployment catalogue, or the `variant` is not one that model offers |
| `not-found` | no such Agent, or not visible to you |
| `forbidden`, `permission-denied` | an Agent this chat does not author and did not create — tell the author to open the Builder on that Agent |
| `invalid-input`, `validation-error` | the input itself is malformed |
| `template-refused` | every refused Template path is listed in `errors[]` with its reason; nothing was saved |
| `template-changed` | `template/` changed during the copy: stop whatever writes into it and save again |
| `operation-off` | the author switched this Operation off for this chat under External services, below the chat; say so, and do not retry |
