---
kind: explanation
adrs: [0037]
---

# Testing

> How is the backend tested: what do the tests drive, what is real, and what is faked?

## How it works

- The backend has one test suite, run per workspace with the `test` script ([Commands](../operations/commands.md)); it needs Docker and nothing else, and runs locally only, with no CI wiring.
- Tests drive the system through a boundary something real touches and assert only on what crosses it: a status code, a response body, a row in Postgres, a request the fake pod received; they never reach for private methods or assert on Nest wiring.
- The outer boundary is the HTTP surface, a Nest test application on the Fastify adapter driven with `app.inject()` and the identity headers oauth2-proxy puts on a request; the inner one is the agent-session handle, the single door to a pod's opencode port ([Connection](../public-api/connection.md)).
- The public-API application also checks itself: every `application/problem+json` it answers is recorded against the route Fastify matched, and closing it fails the file if any of them carries a `type` the operation does not declare in the document the app serves. Coverage is honest rather than exhaustive — it judges the paths the tests exercise and says nothing about the rest.
- Postgres is real: a Testcontainers instance starts once per run, the Drizzle migrations are applied, and the migrated database is cloned once per worker so files run in parallel without sharing rows.
- The pod client is real: a test that needs opencode gets a small HTTP server on an ephemeral port speaking opencode's session routes, so the backend's own client, timeouts, SSE parsing and error mapping execute.
- Kubernetes, Redis, Bifrost, external-services HTTP calls and BullMQ queues are faked, each recording what it was called with; pod readiness is a decision the test makes, so a created [Project](../../CONTEXT.md) sits in `starting` until the test says the pod came up.
- Tests live under `backend/test/`, excluded from the shipped build and grouped by the area a test drives rather than the source file it touches; test-only code, helpers included, never lives under `src/` ([ADR-0037](../adr/0037-backend-tests-are-grouped-by-area-under-test-never-under-src.md)).
- Helpers sit in a `support/` directory beside the tests that use them, one shared at the root and one per area, split by which tests can reach them.

## Code

- `backend/test/` — the suite, grouped by area, with the fakes and helpers in the support directories.
- `backend/test/README.md` — the helper APIs, scripting knobs and what each fake stands in for.

## Related

- [Commands](../operations/commands.md) — the per-workspace scripts including the `check` gate.
- [Connection](../public-api/connection.md) — the agent-session boundary the inner tests drive.
