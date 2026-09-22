---
kind: operations
---

# Upgrade opencode

> Move the agent image to a new opencode build without breaking the connection path or surprising consumers.

Consumers speak the deployed build's protocol directly ([ADR-0038](../adr/0038-chat-is-native-opencode-through-the-runtime-proxy.md)) and the backend reaches a pod's opencode through one module ([ADR-0036](../adr/0036-agent-session-is-the-backends-only-door-to-a-pods-opencode-port.md)), so a bump is an integration event with a short, fixed list of places to check ([Connection](../public-api/connection.md)).

## Prerequisites

- The upstream opencode commit to move to.
- A local stack ([Quickstart](quickstart.md)) and Docker for the backend tests ([Testing](../backend/testing.md)).
- The consumer example under `docs/public-api/example/`.

## Steps

1. Bump both halves together. The agent image installs `@opencode-ai/cli@<build>` in `docker/Dockerfile.agent`, and the vendored tree carries an upstream semver in `frontend/opencode/packages/protocol/package.json`; match them by upstream commit, not by comparing the strings, and move them in one change so the spec the docs page serves is the spec the pod runs. `agent-config/agent-image-version.json` is the image's version and is not the opencode pin.
2. Diff the connection path against the new spec. Every path `backend/src/agent-session/pod-opencode.client.ts` calls must still exist in `frontend/opencode/packages/protocol/openapi.json` with the same parameters: `GET /api/session?parentID=null&order=asc` and the `?cursor=` continuations that page it (the root list the oldest root is picked from; `parentID` must still filter, the response must still carry `data` and `cursor.next`, and every Session must still carry the `time.created` the platform sorts on), `GET /api/session/{id}` (validating a remembered Session and its `parentID`), `POST /api/session`, `GET /api/health` (must still answer `{ healthy, version, pid }` and 503 while starting; `version` is what connect reports as `build`), and `GET /api/session/active` (the probe agent-status and agent-update share). A missing or changed route is work in `backend/src/agent-session/`.
3. Check the Go proxy's prompt pattern. `promptSendPattern` in `proxy/internal/server/server.go` must still match the new build's prompt route; a pattern that stops matching fails nothing loudly, [Projects](../../CONTEXT.md) only stop reordering in the sidebar.
4. Verify the client and runtime pairing. Update `docs/public-api/example/` to the client version matching the new build and run it end to end against the local stack: connect, prompt, events, messages, wait, interrupt. Record the verified pairing in the example's README.
5. Re-read what consumers see. Diff `frontend/opencode/packages/schema/src/session-event.ts` for event kinds and the prompt and message shapes in the vendored spec; anything that moved is a consumer-visible change to announce.
6. Run the connection tests and a live connection. `backend/test/agent-session.test.ts`, `backend/test/public-api/connect.test.ts` and `backend/test/connection-lifecycle.test.ts` cover the primary-Session rule, the budget, lock contention and the failure mapping against a fake runtime and a real Postgres.

## Verify

- The three connection test files pass.
- A connect against a real cold environment succeeds, and opening the same Project in the app lands on the same conversation.
- The example runs end to end and its README names the verified client and runtime pairing.
- `/api/v1/docs` serves the Agent Runtime document from the new vendored spec ([Public API contract](../public-api/contract.md)).
