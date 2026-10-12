---
kind: explanation
terms: [Gate]
adrs: [0078]
---

# Gate

> What does the platform check before a pod's call reaches an External Service, what does it hand the service, and what does it check on the way back?

## How it works

### The call

- Every call a pod makes to an [External Service](../../GLOSSARY.md) is `POST /api/external-services/agent/<slug>/<operation>` with the pod's `service` [Gateway Key](../../GLOSSARY.md) as its bearer, reached through `EXTERNAL_SERVICES_URL` and cluster-internal like the [Service Gateway](../gateways/service-gateway.md) mount. The [Gate](../../GLOSSARY.md) resolves the calling ProjectEnvironment from the key and `<slug>` among the Built-in External Services and its Organization's published Custom External Services; the Organization's own service wins, and a built-in that later takes the same name stays hidden there.
- The checks run in a fixed order, and every one before dispatch runs without waking a service pod; each refusal is `application/problem+json` with the code below:

```
1  caller's key                      401 unauthorized
2  slug                              404 unknown-service
3  service state                     503 service-disabled · 503 service-not-configured
4  the Operation                     404 unknown-operation
5  Project configuration complete    409 configuration-incomplete (lists `missing`)
6  Operation switch                  403 operation-off
7  input size, then schema           413 input-too-large · 400 invalid-input (each error's pointer)
8  bounds                            403 out-of-bounds (operation, bound, pointer, value, allowed)
9  open and trim secrets             500 secret-unreadable
10 dispatch                          503 service-reloading (a Default switch) · 503 service-starting · 502 timeout · 502 service-failed
11 check the answer                  503 service-reloading · 502 secret-in-response · 502 response-too-large
12 write one Call
```

- The Gate route reads at most 25 MB; within that an Operation takes its `limits.inputBytes` (1 MB by default) and runs for its `limits.timeoutSeconds` (30 s by default, 300 at most) plus 5 s of grace. The Gate fills each input's `default`s before the handler sees it.
- The [Service configuration](../../GLOSSARY.md) the call reads is the callers' one; the [Project configuration](../../GLOSSARY.md) is the calling ProjectEnvironment's, read tolerantly against the current manifest ([Configuration](configuration.md)). A builder chat's Test Project reaches the service's Development instead, with Development's own Service configuration ([External Service Builder](external-service-builder.md)).
- `x-opsiforce-via: app` marks a call from App code; a missing header means `agent`. It only labels the [Call log](call-log.md) and grants nothing.

### What the service receives

- The Gate hands the service both configurations in each call's `context`, decrypted for that call only: every sealed secret is opened only at the place it was sealed, and a `list` of the Service configuration that a Project form field picks items from travels cut to the items this Project configuration picked, so a Project given one mailbox never receives another mailbox's token ([ADR-0078](../adr/0078-an-external-service-receives-its-secrets-with-each-call-from-the-gate.md), [ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)). Lists no Project field picks from travel whole.
- A built-in runs in process; a Custom External Service is reached over HTTP at its [Default environment (External Service)](../../GLOSSARY.md)'s pod with that ProjectEnvironment's own `service` key in `x-opsiforce-gate`, which the SDK compares in constant time before any handler runs. A down pod is woken with `ensureEnvironment` and the call held up to 60 s, until the pod reports it serves and has an address (a serving mark left by a pod that was just killed does not end the hold), then answered `503 service-starting` with `Retry-After: 5` ([ADR-0083](../adr/0083-a-custom-external-services-default-environment-never-sleeps-its-state-lives-in-that-environments-workspace-and-is-copied-on-a-switch-and-its-webhook-url-belongs-to-the-service.md)).
- Only the in-process `public-api` built-in gets `ctx.platformApi`: a single-use `gc-` call token the Gate holds in memory and revokes when the call ends ([Public API built-in](public-api.md)).
- `ctx.state` is a key/value store of JSON values, keys of 1–256 characters, that the service pod keeps itself in a SQLite file of its ProjectEnvironment's data folder, `/workspace/data/service-state.db`. Every environment of the service has its own; `data/` is never committed, so a Publish never carries one. Its size is bounded only by the environment's storage. Switching the Default environment holds the service's calls with `503 service-reloading` and `Retry-After: 2` (an incoming webhook waits up to 5 s for the hold to end instead) until the calls in flight finish, copies the old Default's file over the new one's, then moves callers ([ADR-0083](../adr/0083-a-custom-external-services-default-environment-never-sleeps-its-state-lives-in-that-environments-workspace-and-is-copied-on-a-switch-and-its-webhook-url-belongs-to-the-service.md)). A built-in has none: its `ctx.state` throws.

### What comes back

- Every call to a service carries the manifest hash the Gate enforces as `x-opsiforce-expected-manifest`, and the SDK answers `503 service-reloading` without running a handler when it serves another one, so a write never runs against a manifest the Gate did not check. A call that was routed to the old Default environment while a switch moved it is refused the same way; an incoming webhook is instead logged as `503 service-moved` and routed once more, a single time, to the new Default, while one whose hold outlasts its 5 s wait is answered `503 service-reloading` without a second try, so a sender never waits much past 5 s.
- The Gate checks every answer before passing it on: one stamped with another manifest hash in `x-opsiforce-manifest` is `503 service-reloading` with `Retry-After: 2`, one whose body contains a secret the Gate sent is withheld as `502 secret-in-response`, a pod's answer over 25 MB is `502 response-too-large` (an in-process built-in's has no cap), and a pod that cannot be reached, refuses the Gate's key or answers a status other than 200, 204, 400, 404, 409, 422, 429 or 502 is `502 service-failed`, except the `403 out-of-bounds` problem a handler's `ctx.bounds` check answers. A service's own problem passes through with its status, `code` and `Retry-After`. A form call's answer reaches the browser only as JSON in the shape its route allows (options, info or a button result), re-encoded by the Gate, else `502 service-failed`, and every Gate answer carries `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`. A manifest-hash mismatch is logged as an error, except from a Development lane, where `yarn dev` reloads make it expected.
- Every call, allowed or refused, writes one Call row with the service, Operation, kind, decision, status, code, bound values touched, sizes and duration, never a body ([Call log](call-log.md)).

### Reads for the calling agent

- Three reads ride the same key and always answer for the caller's own ProjectEnvironment: `GET agent/<slug>` (describe: each Operation's kind and switch, the Project configuration with secrets as `{stored: true}` and chosen values labelled from `_labels`, the rendered `info` templates, `complete` and `missing`), `GET agent/<slug>/openapi.json` (OpenAPI 3.1 built from the manifest the Gate enforces, every Operation a `POST` with its bound inputs explained and its problems declared, `ETag` = the manifest hash, `304` on `If-None-Match`) and `GET agent/<slug>/calls?limit=` (that ProjectEnvironment's Calls to the service, newest first, 50 by default, at most 200). None writes a Call, and no service's document is part of the public `/api/v1/docs`.

## Edge cases

- When the service's Service configuration is incomplete, every call answers `503 service-not-configured` before the Operation is even looked up.
- When the Project configuration lacks a required value or holds one the current manifest no longer accepts, the call answers `409 configuration-incomplete` naming the fields.
- When an Operation is new since the Project configuration was saved, it reads as switched off and answers `403 operation-off`.
- When a custom service is disabled or deleted, its calls answer `503 service-disabled` or `404 unknown-service`; a disabled service whose files cannot be served answers `503 service-disabled` too.
- When a sealed value was copied to another row, opening it fails and the call answers `500 secret-unreadable` without reaching the service.
- When a published custom service's files fail `check` or vendor an SDK of another major than 1, its calls answer `502 service-failed`.

## Code

- `backend/src/external-services/gate/` — the Gate, its refusals, the dispatcher and pod waking, the answer checks, describe, `openapi.json` and the Call write.
- `backend/src/external-services/configuration/configuration-delivery.ts` — opening and trimming the configurations each call carries.
- `backend/src/external-services/custom/service-state-files.ts` — copying the `ctx.state` file on a Default environment switch and removing Development's on Reset.
- `external-service-sdk/` — the Operation admission and bounds checker the Gate imports.

## Related

- [Service manifest](service-manifest.md) — what declares the Operations, inputs and bounds the Gate enforces.
- [Configuration](configuration.md) — the two configurations the Gate reads.
- [Call log](call-log.md) — where every call is recorded and who reads it.
- [Service Gateway](../gateways/service-gateway.md) — the key the Gate authenticates.
- [Public API built-in](public-api.md) — the in-process built-in that reaches `/api/v1` through the Gate.
