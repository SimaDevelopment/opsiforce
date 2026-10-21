---
kind: operations
---

# Upgrade opencode

> Move the agent image to a new opencode build without breaking the connection path or surprising consumers.

Consumers speak the deployed build's protocol directly ([ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md)) and the backend reaches a pod's opencode through one module ([ADR-0036](../adr/0036-agent-session-is-the-backends-only-door-to-a-pods-opencode-port.md)), so a bump is an integration event with a short, fixed list of places to check ([Connection](../public-api/connection.md)).

## Prerequisites

- The owner's call to bump. Following opencode is manual, with no bot, schedule or staleness check; the pin is an exact `X.Y.Z`, never `latest` or a range, and minor and major releases follow the same rule.
- A delta note from the current pin to the new build, written before the bump. It covers what Opsiforce touches: the server routes the backend calls, the event schema, the embed's dependencies and GUI surfaces, model request shapes, the plugin API, database migrations and config keys.
- A local stack ([Quickstart](quickstart.md)) and Docker for the backend tests ([Testing](../backend/testing.md)).
- The consumer example under `docs/public-api/example/`.
- `kubectl` access to the dev and prod namespaces, written `$NS` below, and the Bifrost dashboard of each.

## Steps

1. Bump both halves together. The agent image installs `@opencode/cli@<build>` in `docker/Dockerfile.agent`, and the vendored tree carries an upstream semver in `frontend/opencode/packages/protocol/package.json`; match them by upstream commit, not by comparing the strings, and move them in one change so the spec the docs page serves is the spec the pod runs. `agent-config/agent-image-version.json` is the image's version and is not the opencode pin. `opencode-plugins/package.json` pins `@opencode/plugin@<build>` and the plugin's TypeScript toolchain exactly, and the Dockerfile's `opencode-plugins` stage installs from it; the plugin pin moves with the CLI pin, and `backend/test/platform-contract.test.ts` fails while they differ.
   - Replace `frontend/opencode/` wholesale with `git archive v<build>` of upstream, minus every `AGENTS.md`, `.vscode/`, `.opencode/skills/opencode-dev/`, `.opencode/.gitignore` and `.opencode/themes/.gitignore`. Stage it with `git add -f`, since the vendored `.gitignore`s hide tracked upstream files, and edit nothing inside it.
   - Regenerate the explicit `@opencode/ui/*` and `@opencode/session-ui/*` entries in `frontend/tsconfig.json` from those packages' `exports` maps; the Vite resolver reads the maps live.
2. Diff the connection path against the new spec. Every path `backend/src/agent-session/pod-opencode.client.ts` calls must still exist in `frontend/opencode/packages/protocol/openapi.json` with the same parameters: `GET /api/session?parentID=null&order=asc` and the `?cursor=` continuations that page it (the root list the oldest root is picked from; `parentID` must still filter, the response must still carry `data` and `cursor.next`, and every Session must still carry the `time.created` the platform sorts on), `GET /api/session/{id}` (validating a remembered Session and its `parentID`), `POST /api/session`, `GET /api/info` (must still answer `version`, 503 while starting and 500 once the runtime failed to start; `version` is what connect reports as `build`, and the pod's readiness probe asks the same route), and `GET /api/session/active` (the probe agent-status and agent-update share). A missing or changed route is work in `backend/src/agent-session/`.
3. Re-check what opencode would ignore silently. It drops a config key it does not know and reads `/etc/opencode` above every other layer, so a rename or a new file undoes a setting with no error. In the new build's source, confirm each of these still exists under the same name, and that `agent-config/opencode.json` and `opencode.local.json` still carry them byte-identically:
   - the HTTP transport key, `providers.openai.settings.transport: "http"` ([LLM Gateway](../gateways/llm-gateway.md));
   - the opt-out keys: model `settings.textVerbosity`, model `compatibility.supportsEffortUpdates`, and the `-opencode.tools` entry in `plugins`, which still removes the worktree, session-rename and models tools by exact id;
   - the observer's entry in `plugins`, an absolute directory path that opencode resolves to `<dir>/server`, then `<dir>/index`;
   - no `/etc/opencode`: neither `docker/Dockerfile.agent` nor anything it installs creates it.

   Then run the chat-only embed against the new tree and hide every new surface opencode's GUI adds with a `.oc-chat-only` rule in `frontend/src/components/project/opencode-overrides.css`, deleting rules whose target is gone; the chat header stays as shipped ([OpenCode Embed](../frontend/opencode-embed.md)).
4. Verify the client and runtime pairing. Update `docs/public-api/example/` to the client version matching the new build and run it end to end against the local stack: connect, then the event recipe in [Connection](../public-api/connection.md), then messages and interrupt. Record the verified pairing in the example's README.
5. Let the docs and the example follow the build. Diff `frontend/opencode/packages/schema/src/session-event.ts` for event kinds and the prompt and message shapes in the vendored spec; anything that moved changes [Connection](../public-api/connection.md), the example and its README in the same change, with no announcement beyond them.
6. Run the connection tests. `backend/test/agent-session.test.ts`, `backend/test/public-api/connect.test.ts` and `backend/test/connection-lifecycle.test.ts` cover the primary-Session rule, the budget, lock contention and the failure mapping against a fake runtime and a real Postgres; `backend/test/platform-contract.test.ts` covers the step 3 keys, and `node --test` in `opencode-plugins/` covers the observer.
7. Roll out, dev first.
   - Ship the image change with an empty `requiresPodRecreate` migration: idle pods are recreated at backend boot, busy ones when their turn ends, pool slots recycle through the version bump, and suspended Projects start on the new image when next opened ([Agent Updates](../agent-system/agent-updates.md)).
   - Merging to `main` deploys dev. Run the Verify list there; prod moves only when the owner pushes `production-opsiforce`, then run it again on prod.
   - There is no way back: no `opencode.db` copy, no volume snapshot, no downgrade. A problem is fixed forward, on our side or with a newer pin.
   - Azure, installed by hand, moves at its next deploy together with the Bifrost image and chart in `helm/bifrost/values.azure.yaml` ([Deploy on Azure](deploy-azure.md)).
   - Expected noise: an open browser tab breaks until reloaded, including between the backend and frontend Helm releases.

## Verify

After the dev deploy, and again after promoting prod:

- Agent pods run the new image: `kubectl -n $NS get pods -l app=opsiforce-agent -o custom-columns='POD:.metadata.name,IMAGE:.spec.containers[0].image'` shows the tag in `agent-config/agent-image-version.json` on every pod once its turn has ended.
- A cold chat opens: a suspended Project wakes, its chat renders, and the app lands on the same conversation as before.
- A turn on an OpenAI model answers and shows a `POST /v1/responses` in Bifrost with no WebSocket session.
- A turn on a Claude model answers.
- The sidebar shows the Project Working during a turn and Idle after it ([Agent Status](../agent-system/agent-status.md)).
- `GET /api/plugin?location[directory]=/workspace` on one dev pod's `:4096` proxy lists `opsiforce.observer` as `active`; a load failure is per image, so one pod answers for all. Ask after that Project's chat has been opened: until the `/workspace` location has loaded, the list is empty, built-ins included.
- `/api/v1/docs` serves the Agent Runtime document from the new vendored spec: `GET /api/v1/runtime/openapi.json` lists the same operations as `frontend/opencode/packages/protocol/openapi.json` ([Public API contract](../public-api/contract.md)).
- The image has no `/etc/opencode`: `kubectl -n $NS exec <pod> -c opencode -- test ! -e /etc/opencode` succeeds.
- The step 6 test files pass, and the example's README names the verified client and runtime pairing.

Two GA behaviours are not regressions:

- opencode has no inactivity cut: a run waiting on a question, a permission or a shell call the model started with `timeout: 0` stays Working until someone answers or interrupts it, and a Working Agent holds its pod ([Pod Lifecycle](../runtime/pod-lifecycle.md)). `experimental.location_idle_timeout` only unloads idle locations and never ends a run.
- Claude 5.1+ requests carry `thinking.block_binding` and its beta header, which Bifrost drops for every upstream, so Anthropic never sees them; how Anthropic answers a thinking-block mismatch without them is unverified, so check it first when a Claude turn fails on thinking blocks.
