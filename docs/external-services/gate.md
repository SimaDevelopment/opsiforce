---
kind: explanation
terms: [Gate, Caller identity]
adrs: [0046, 0078, 0083]
---

# Gate

> How does a call from a pod reach an External Service, what does the service learn about the caller, and how does the platform call a service itself?

## How it works

### A caller's call

- Every call a pod makes to an [External Service](../../GLOSSARY.md) goes to the service's [Service host](../../GLOSSARY.md), `<slug>.external-services.<base>`, with the pod's [Gateway Key](../../GLOSSARY.md) in any header, and passes the [Gate](../../GLOSSARY.md): the `external-service` runtime proxy (the Gate's proxy, [Request flows](../runtime/request-flows.md#service-hosts)) and the backend's resolve endpoint behind it.
- The backend answers `POST /api/internal/proxy/external-services/resolve` (`{credential, slug}` with the proxy control token, `credential` being the header value that carries the caller's Gateway Key, Basic credentials decoded). It resolves the calling ProjectEnvironment from the key and `<slug>` among the Built-in External Services and its Organization's published Custom External Services; the Organization's own service wins, and a built-in that later takes the same name stays hidden there.
- Its answer is the pod's address and a freshly minted [Caller identity](../../GLOSSARY.md) (`kind: call`, the tenant, Project, ProjectEnvironment and environment slug, two minutes long) signed with the receiving copy's own Gateway Key ([ADR-0046](../adr/0046-an-external-service-owns-its-api-and-its-service-policy-the-gate-only-identifies-the-caller-finds-the-service-and-forwards-the-call-untouched.md)). For a built-in served in the backend (`incoming-email`, `whatsapp`, `public-api`) it is `servedBy: "built-in"` with a backend path, and the Caller identity is signed with the built-ins key.
- A Test Project resolves to Development, and every other caller to the service's [Default environment (External Service)](../../GLOSSARY.md). A sleeping copy is woken and the answer held up to 60 s, until the pod reports it serves and has an address ([ADR-0083](../adr/0083-a-custom-external-services-default-environment-never-sleeps-its-state-lives-in-that-environments-workspace-and-is-copied-on-a-switch-and-its-webhook-url-belongs-to-the-service.md)).
- Every refusal is `{message}`: 401 for a missing, unknown or revoked key or a disabled Project's, 404 for an unknown, unpublished, deleted, disabled ("… is turned off in this Organization") or SDK 1 service, 502 when the pod failed, 504 when it did not start in time.
- The Gate forwards the request untouched apart from the credential: the header that carried the key is replaced by the Caller identity in `X-Opsiforce-Caller`, and incoming `X-Opsiforce-*` headers are dropped. It never reads, changes or judges what was asked or what comes back, and it keeps no record of the call: the service's own [Service policy](../../GLOSSARY.md) decides, and its SDK writes the [Call log](call-log.md).

### What the service receives

- The SDK checks the Caller identity's signature with its pod's own key, its expiry and that it was made for this copy, before any Service route runs; nothing the request says about itself counts.
- No configuration travels with a caller's call. The SDK fetches the calling ProjectEnvironment's Project configuration and the Service configuration from the backend with its pod's own key, holds them in memory and drops a copy when the backend tells it of a save ([Configuration](configuration.md), [ADR-0078](../adr/0078-an-external-service-fetches-its-configurations-from-the-backend-by-the-caller-identity-and-holds-them-only-in-memory.md)).
- `ctx.state` is a key/value store of JSON values, keys of 1–256 characters, that the service pod keeps itself in a SQLite file of its ProjectEnvironment's data folder, `/workspace/data/service-state.db`, beside the records file `service-records.db`. Every environment of the service has its own; `data/` is never committed, so a Publish never carries one. Its size is bounded only by the environment's storage. Switching the Default environment holds the platform's own calls with `503 service-reloading` and `Retry-After: 2`, and a caller's or webhook's resolve waits within its 60 s hold (`504` past it), until the platform's calls in flight finish; it copies the old Default's files over the new one's, then moves callers ([ADR-0083](../adr/0083-a-custom-external-services-default-environment-never-sleeps-its-state-lives-in-that-environments-workspace-and-is-copied-on-a-switch-and-its-webhook-url-belongs-to-the-service.md)).

### The platform's own calls

- The platform calls a service itself for a form's options, info or buttons while someone edits a Form, and for its after-save hooks: `POST /.well-known/opsiforce/{options|info|buttons|hooks}/<name>` at the copy's pod, or in process through the built-ins adapter, with a `platform` Caller identity naming the ProjectEnvironment it acts for (or none, for the service as a whole).
- A form call's body carries the unsaved values with stored secrets filled in and opened; a hook's carries the previous and current values. Every sealed secret is opened only at the place it was sealed ([ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)).
- Each of these calls carries the manifest hash the platform uses as `x-opsiforce-expected-manifest`, and the SDK answers `503 service-reloading` without running a handler when it serves another one. An answer stamped with another manifest hash in `x-opsiforce-manifest` is `503 service-reloading` with `Retry-After: 2` too; a mismatch is logged as an error, except from a Development lane, where `yarn dev` reloads make it expected.
- A form call runs for at most 10 s plus 5 s of grace. Its answer is read up to 2 MB and reaches the browser only as JSON in the shape its route allows (options, info or a button result), re-encoded by the platform, else `502 service-failed` (`response-too-large` over 2 MB); options are cut to the first 50, and a button image must be png, jpeg, gif or webp (its bytes matching the type) of at most 1 MB. A service's own refusal passes through with its status and message. A failure reads in plain words with the service's display name ("<Name> couldn't do this. Try again; if it keeps failing, an Organization admin can check this service's Calls.", "<Name> sent choices this form can't show.", "<Name> couldn't start."), a form call that no longer fits the manifest "This form is out of date. Reload the page and try again."; handler names, codes and call ids stay in the logs and the service's Calls tab.
- These calls are not held by a Default-environment switch: while one holds the lane, or when a call was routed to the old Default while a switch moved it, it is refused `503 service-reloading` at once, and the form or hook can be retried.

## Edge cases

- When a key belongs to a disabled Project, the resolve answers 401: a disabled Project's key identifies no one.
- When a custom service is disabled, deleted or never published, the resolve answers 404 and the Gate forwards nothing.
- When a service is built on SDK 1, the resolve answers 404 "… is built on SDK 1 and must be rebuilt on SDK 2 or deleted.": the platform serves no SDK 1 service, and its page says to rebuild or delete it ([External Service Builder](external-service-builder.md)).
- When a path holds `.` or `..` segments, the edge resolves them before the Gate (Traefik's path sanitizing, left on), so `/1/boards/<a>/../<b>/cards` reaches the service as `/1/boards/<b>/cards` and its Service policy judges `<b>`, the path that is actually forwarded. The SDK's *not supported* refusal of unsafe paths stays as defence in depth for whatever still reaches a service unresolved: an encoded form the edge leaves, or a request that did not cross the edge.
- When the Project configuration lacks a required value, the platform still forwards the call; the SDK refuses it with a message naming the field and a link to the configuration ([Configuration](configuration.md)).
- When a sealed value was copied to another row, opening it for a form call or hook fails with `500 secret-unreadable` without reaching the service.

## Code

- `proxy/internal/gate/` — the Gate's proxy: finding the key, the caller cache, forwarding, the webhook lane.
- `backend/src/external-services/http/gate.controller.ts` — the resolve endpoints the Gate's proxy calls.
- `backend/src/external-services/gate/` — the resolve answer (the key in a header value, the copy, the pod and the minted Caller identity), its cache eviction, the platform's form and hook calls, the dispatcher and pod waking, the manifest-hash check and the Default-environment holds.
- `backend/src/external-services/configuration/configuration-delivery.ts` — opening the configurations a form call or hook carries.
- `backend/src/external-services/custom/service-state-files.ts` — copying the data files on a Default environment switch and removing Development's on Reset.

## Related

- [Request flows](../runtime/request-flows.md) — the Gate's proxy and the Service hosts.
- [Service manifest](service-manifest.md) — what a service is made of and the SDK that enforces its Service policy.
- [Configuration](configuration.md) — the two configurations a service fetches.
- [Call log](call-log.md) — the records a service keeps of every call.
- [Service Gateway](../gateways/service-gateway.md) — the key the Gate authenticates.
- [Public API built-in](public-api.md) — the in-process built-in that `/api/v1` serves on its Service host.
