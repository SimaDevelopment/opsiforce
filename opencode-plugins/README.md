# opencode plugins

Opsiforce's opencode server plugins. Each one is built into the agent image as a self-contained bundle under `/opt/opsiforce/opencode-plugins/<name>/index.js` and listed once, by that directory, in the image `opencode.json` `plugins` array ([ADR-0093](../docs/adr/0093-opsiforce-extends-opencode-through-plugins-baked-into-the-agent-image-one-per-risk-class.md)).

| Path | What it holds |
|---|---|
| `observer/` | `opsiforce.observer`: `index.ts` is the entry opencode loads, `observe.ts` the logic |
| `test/` | `node --test` against the logic with a fake host |

## `opsiforce.observer`

Watches opencode and tells the backend what it saw. It registers **no hooks**, only a `ctx.event.subscribe()` consumer, so a bug in it can make a signal stale but never fail a turn.

| opencode event | Observation posted |
|---|---|
| `session.execution.started` | `{ kind: "run.started", sessionId }` |
| `session.execution.succeeded` / `failed` / `interrupted` (any reason) | `{ kind: "run.ended", sessionId }` |
| `session.renamed` | `{ kind: "titled", sessionId, root, title }` |
| `session.inbox.enqueued` with `item.type === "user"` | `{ kind: "prompted", sessionId, root }` |

Every other event, and every other inbox item type, is ignored. `root` is true when the session has no `parentID` (`ctx.session.get`). The observer decides nothing: what counts as Working, which title names the Project and which item stamps a Prompt are backend rules.

- **Where it posts.** `POST ${SERVICE_GATEWAY_URL}/agent/observations` with `Authorization: Bearer ${SERVICE_GATEWAY_API_KEY}`, the environment's gateway key that the pod template already puts in the `opencode` container's environment (the same key and header agent-control's pusher uses).
- **Delivery.** Fire-and-forget: each observation is posted on its own, up to 4 attempts (5 s timeout each, backoff 1.5 s, 3 s, 4.5 s, like agent-control's `push.go`), then dropped and logged. No queue, no persistence.
- **`setup`.** Reads the two env vars and throws only when either is missing, so the plugin shows `failed` in `GET /api/plugin`. It starts the consumer in the background and returns at once, with no awaited I/O. A failed event stream is logged and resubscribed after 1 s; the cleanup opencode calls on unload ends the subscription.

## The guard rule

**Every event handler and every hook body catches its own throw, logs it and never rethrows.** An event consumer that throws ends its `for await` loop and stops reporting for the life of the pod. opencode awaits hooks in the request path, so a hook that throws fails the operation it hooks; on opencode 2.x **`tool.hook("execute.after")` is the hook where a missed catch fails the user's turn**.

## Testing and building

- `node --test 'test/**/*.test.ts'` from this directory. Logic modules import nothing from opencode, so the tests need no installed dependency; only `observer/index.ts` imports `@opencode/plugin`, and only for types.
- `@opencode/plugin` is pinned to the exact opencode CLI version and moves with every opencode bump; the bump's delta note re-checks the event names and payloads above.
- The agent image's `opencode-plugins` Dockerfile stage typechecks the package against the pinned `@opencode/plugin`, then builds every `<name>/index.ts` with `bun build --target bun --external effect --external @opencode/plugin` into `/opt/opsiforce/opencode-plugins/<name>/index.js`. A new plugin needs no Dockerfile change, only its directory and its entry in the `plugins` list of both `agent-config/opencode.json` and `opencode.local.json`.
