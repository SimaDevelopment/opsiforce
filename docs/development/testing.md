# Testing

> How the backend is tested: what the tests drive, what is real, and what is faked.

The backend has one test suite, run locally with `yarn workspace @opsiforce/backend run test`. It
needs Docker running and nothing else — no cluster, no Redis, no seeded database. There is no CI
wiring yet; the suite is a developer's tool.

## The shape of a test

Opsiforce tests drive the system through a boundary something real touches, and assert only on what
crosses it: a status code, a response body, a row in Postgres, a request the pod received. They do
not reach for private methods or assert on how Nest is wired, because that is the part most likely
to change without anything breaking for a consumer.

Two boundaries matter. The outer one is the HTTP surface: a Nest test application on the Fastify
adapter, driven with `app.inject()` and the identity headers oauth2-proxy puts on a request. The
inner one is the agent-session handle, the single door to a pod's opencode port, which has
behaviours no HTTP route reaches directly.

## What is real

The domain services are real classes reading and writing a real Postgres. A Testcontainers instance
starts once per run and the Drizzle migrations are applied to it; that migrated database is then
cloned once per test worker, so files run in parallel without sharing rows. The domain services are
compiled into a Nest testing module on top. Visibility rules, workspace placement, environment lifecycle and
session write-back are therefore asserted on rows, not on mock call counts.

The pod client is real too. When a test needs opencode, it gets a small HTTP server on an ephemeral
port speaking opencode's session routes — so the backend's own client, its timeouts, its SSE parsing
and its error mapping all execute for real. Faking the client instead would leave exactly the code a
bump breaks untested.

## What is faked

Everything that leaves the process and is not the thing under test: Kubernetes, Redis, Bifrost, the
external-services HTTP calls and the BullMQ queues. Each fake records what it was called with, so a
test can assert that a pod was requested without a cluster existing.

Pod readiness is a decision the test makes, not a race it waits out. A created Project sits in
`starting` until the test says the pod came up (or failed), which keeps the lifecycle assertions
deterministic.

## Where it lives

Everything is under `backend/test/`, excluded from the shipped build, and grouped by the area a test
drives rather than by the source file it happens to touch — a test that enters at a boundary lands in
several `src` modules, so there is rarely one to sit beside. Test-only code never lives under `src/`,
helpers included. Both rules and why they came out that way are [ADR 0037](../adr/0037-backend-tests-are-grouped-by-area-under-test-never-under-src.md).

Helpers sit in a `support/` directory beside the tests that use them — a shared one at the root, an
area-local one per area — split by which tests can reach them rather than by what they are called.
The tree as it stands, and the practical reference for the helper APIs, the scripting knobs and what
each fake stands in for, is [`backend/test/README.md`](../../backend/test/README.md).

## See also

- [Commands](commands.md) — the other per-workspace scripts, including the `check` gate.
