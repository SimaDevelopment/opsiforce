# Recorded opencode payloads

Frozen-contract fixtures for the public chat facade. Each file is one response body the pod's
opencode returns at the build pinned in `docker/Dockerfile.agent`, kept verbatim:
`session.json` is `GET /api/session/{id}`, `inbox-user.json` is the entry
`POST /api/session/{id}/prompt` answers with, and every file under `messages/` is one entry of
`GET /api/session/{id}/message`. Every file under `events/` is one frame body of
`GET /api/event`, one per kind the public event stream forwards.

`public-api/chat-contract.test.ts` parses each of them with the frozen public schemas and asserts
that nothing is added, dropped or retyped. That is the loud failure step 3 of
[the bump runbook](../../../../docs/public-api/opencode-bump.md) relies on: re-record these against the
new build, and a diff here is either adapter work or a deliberate, additive change to the public
contract.

The variants a live session rarely produces on demand — compaction, the switch notices, a failed
tool turn — were written against the vendored protocol spec of the same snapshot rather than
captured, and carry realistic values. The whole of `events/` was written the same way, against
`packages/schema/src/session-event.ts` of that snapshot. Replace them with real recordings whenever
a session produces one.
