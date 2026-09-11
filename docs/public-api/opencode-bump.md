# Runbook: upgrading opencode under the public API

> What to check when the agent image moves to a new opencode build. Consumers speak the deployed build's protocol directly ([ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md)), and the backend reaches the pod for lifecycle and connection through one module ([ADR-0036](../adr/0036-agent-session-is-the-backends-only-door-to-a-pods-opencode-port.md)), so a bump has a short, fixed list of places to look.

## Why a bump is an event

There is no longer a frozen copy of opencode's shapes to re-check: the platform does not own the chat contract, so a bump cannot break a schema we publish. What it can break is everything the platform *does* own that happens to touch opencode — the connection path, the probes, the prompt-stamp pattern — and, for consumers, the protocol itself. A bump is therefore an integration event, not a schema event.

Pinning a client version does not protect a consumer from this. Builds follow the platform's rollout; the client and the runtime are a pairing, verified together in step 4.

## The procedure

1. **Bump both halves together.** The agent image's pinned build and the vendored source under `frontend/opencode/` are the same upstream snapshot; move them in one change so the spec you read is the spec the pod runs. The two pins live apart and do not share a version string: the image installs `@opencode-ai/cli@<build>` in `docker/Dockerfile.agent`, while the vendored tree carries an upstream semver in `frontend/opencode/packages/protocol/package.json`. Match them by upstream commit, not by comparing the strings. `agent-config/agent-image-version.json` is the *image's* version and moves for reasons unrelated to opencode; it is not the opencode pin. The vendored `packages/protocol/openapi.json` is no longer only a reference you read during a bump: the backend serves it as the second document on `/api/v1/docs`, so leaving it behind publishes a runtime API that no longer matches the pod.

2. **Diff the connection path against the new spec.** Every path `backend/src/agent-session/pod-opencode.client.ts` calls must still exist in `frontend/opencode/packages/protocol/openapi.json` with the same parameters. That list is now short, and it is the whole of what the backend depends on:
   - `GET /api/session?parentID=null&order=asc&limit=1` — the oldest root Session. Check that `parentID`, `order` and `limit` all still behave: a build that ignores `limit` or drops `order` silently changes which Session becomes primary, and that is how an existing conversation gets orphaned. Note the trap: session ids are *descending*-encoded, so a newer Session sorts **lower** as a string — `order=asc` is by creation time, and re-deriving the order from the id would pick the wrong root.
   - `GET /api/session/{id}` — validating a remembered Session, and the `parentID` field that decides whether it is a root.
   - `POST /api/session` — creating one when there is no root.
   - `GET /api/health` — the readiness and build observation. Confirm it still answers `{ healthy, version, pid }` and still uses `503` while the runtime is starting; `version` is what `connect` reports as `build`.
   - `GET /api/session/active` — the session-free probe agent-status and agent-update share.
   A missing or changed route is connection-service work, in `agent-session/`.

3. **Check the Go proxy's prompt pattern.** The browser and program paths both detect prompt sends by URL pattern to stamp the last prompt — `promptSendPattern` in `proxy/internal/server/server.go` — and it must still match the new build's prompt route. A pattern that stops matching does not fail anything loudly; Projects quietly stop reordering in the sidebar.

4. **Verify the client/runtime pairing.** Update [`example/`](example/) to the client version that matches the new build, and run it end to end against a local stack: connect, prompt, events, messages, wait, interrupt. This is the step that stands in for the contract tests the facade used to have. Record the verified pairing in the example's README so a consumer knows which client goes with which runtime.

5. **Re-read what consumers see.** The example passing means the platform still works. It does not mean nothing changed for consumers: diff `frontend/opencode/packages/schema/src/session-event.ts` for event kinds, and the prompt and message shapes in the vendored spec. Anything that moved is a consumer-visible change to announce, not something the platform will absorb.

6. **Run the connection tests and a live connection.** `backend/test/agent-session.test.ts`, `backend/test/public-api/connect.test.ts` and `backend/test/connection-lifecycle.test.ts` run against a fake runtime and a real Postgres, covering the primary-Session rule, the budget, lock contention and the failure mapping. Then connect once against a real cold environment, and open the same Project in the app to confirm both surfaces land on the same conversation.

## What a bump no longer touches

The public schemas (there are none for chat), the event allow-list (there is none), the message variant list (there is none), the fixtures that pinned them. Those are gone with the facade. What remains owned by the platform and governed by the compatibility policy in [overview.md](overview.md#how-the-contract-evolves) is `/api/v1`: `me`, Agents, Projects, the environment descriptor, the connection response and the Error catalogue.
