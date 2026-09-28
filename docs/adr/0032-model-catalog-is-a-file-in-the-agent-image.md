# The model catalog is a file baked into the agent image

On opencode 1.18.18 the picker was constrained with `provider.<id>.whitelist`. OpenCode v2 removed that field with no replacement, and a provider named in `opencode.json` is force-enabled together with its entire models.dev catalog; the `models` map only overlays metadata onto it. The v2 embed therefore showed 69 models and the "OpenCode Zen" provider. The `provider.use` deny we had placed under `permissions` was inert: only `experimental.policies` reads that action.

v2 accepts `OPENCODE_MODELS_PATH`, a models.dev-format JSON that becomes the exclusive catalog, and `OPENCODE_DISABLE_MODELS_FETCH` to stop the background refresh. `agent-config/models.json` is that catalog: the same shape as `https://models.dev/api.json` (provider → `models` map, same field names), hand-maintained, holding only our providers and models and only the fields opencode reads (`limit`, `reasoning`, `tool_call`, `modalities`, `release_date`, `cost`, `experimental.modes`; the descriptive fields and cost tiers are omitted). It is copied into the image as `/opt/opencode/models.json`. Adding a model means copying its models.dev record into the file with those fields. A generator that derived the file from the snapshot bundled in opencode was tried and rejected: upstream last touched that snapshot on 2026-08-12 and treats it only as a boot-time floor, so it lags every new model by weeks. Generating from the live models.dev feed was also rejected as machinery out of proportion to five records; correctness here means declaring what we run with, and a reviewable hand-edited file does that best.

Two details of the file are deliberate. models.dev entries carry `experimental.modes`, which opencode expands into derived models: `gpt-5.6-sol`'s `fast` mode becomes `gpt-5.6-sol-fast`, sending `service_tier: priority` against `gpt-5.6-sol` at double the price. That is what "GPT-5.6 Sol Fast" has always meant on both opencode versions, and it is the only form OpenAI accepts: the relay forwards model names verbatim, and a request for a model literally named `gpt-5.6-sol-fast` returns 400. An allow-list entry names the modes it wants (`{"id": "gpt-5.6-sol", "modes": ["fast"]}`); every other mode is dropped; the `gpt-5.6-sol-fast` ids in `helm/bifrost` and `codex-proxy` are allow-list entries, not upstream models. And the picker hides models older than six months unless they are the newest in their family, so a model older than six months is hidden by default unless it is the newest in its family; today only `claude-haiku-4-5` falls in that category and shows only through search.

Verified live on 2026-09-04 with a second opencode instance in a pod: the catalog matched the file, prompts through Bifrost succeeded, and no models.dev request was made.

## Considered options

- **A `catalog.transform` plugin pruning to an allow-list.** Rejected: code on a beta plugin API, and a plugin that fails to load does so silently, which happened to our image-normalize plugin the same week.
- **Disabling the models.dev plugin and declaring everything in `opencode.json`.** Rejected: works only with `package` and `env` declared per provider (otherwise prompts fail silently), and config cannot set a release date, so the picker hides every model except the current selection.
- **Registering the gateway as a custom provider id and denying all others with policies.** Rejected: renames every stored model reference and stamped workspace config.

## Consequences

- Adding a model is one record in `models.json` plus its variants in `opencode.json`. The standalone quickstart appends a minimal record itself.
- Metadata changes only when someone edits the file, and the diff shows exactly what moved.
- Environment changes ride the pod recreate an image change already requires.
