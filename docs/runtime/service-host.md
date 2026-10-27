---
kind: explanation
terms: [Service host]
---

# Service host

> How does a call to a Service host reach an External Service's pod, and what does the Gate's proxy change and answer on the way?

## How it works

### Reaching the proxy

- A pod or any other client calls `https://<slug>.$EXTERNAL_SERVICES_HOST`, its [Service host](../../GLOSSARY.md), with its [Gateway Key](../../GLOSSARY.md) in any request header. Pods get `EXTERNAL_SERVICES_HOST=external-services.<base>` (backend setting `externalServicesHost`).
- Traefik routes that host family straight to the `external-service` mode of the runtime proxy (the [Gate](../../GLOSSARY.md)'s proxy), with no identity proxy in front. Its second port (3008) is the webhook lane: Traefik sends the main host's `/api/external-services/webhooks/**` there, also with no identity proxy in front ([Event](../external-services/events.md)).

### Resolving and forwarding

- The Gate looks for a `gw-…` value in every header, `Authorization: Basic` decoded first (username or password), never in the URL or body. It sends that value and the host's first label to the backend's resolve endpoint, which answers the pod's address and a freshly minted Caller identity, or a refusal.
- For a built-in (`public-api`, `incoming-email`, `whatsapp`) the answer is `servedBy: "built-in"` with a backend path. The Gate forwards to the backend at that path plus the request's own (the built-ins adapter, [Call log](../external-services/call-log.md#built-ins)), and the webhook lane does the same.
- It removes the header the key was in and every incoming `X-Opsiforce-*` header, adds `X-Opsiforce-Caller`, and forwards everything else untouched over HTTP/1.1: method, path, query, headers, body, chunked and gzip uploads, any `Upgrade`, the original `Host` with `X-Forwarded-Host`/`-Proto`. Answers of every status come back untouched and streamed with an immediate flush, with no CORS headers added and `OPTIONS` forwarded.
- The path it forwards is the one Traefik hands on: Traefik's path sanitizing, on by default, resolves `.` and `..` segments at the edge, so a dot-segment path reaches the service already resolved and is judged on its real target ([Gate](../external-services/gate.md#edge-cases)).
- Its only own answers are `{"message"}` bodies: 401 with `WWW-Authenticate: Basic realm="Opsiforce"` (no key, or the backend refused it), 404 (no such service for the caller's Organization, disabled, deleted, never published), 502 (the pod refused the connection) and 504 (not ready within the hold). The backend holds a waking pod for up to 60 s, and the Gate waits 65 s for that answer.
- It keeps no request log and sets no size, duration or first-byte limit, and Traefik's read timeout on the public entrance is off so long uploads are not cut. It closes an idle connection to a pod after 60 s, before the SDK server's 75 s keep-alive ends, and the SDK never times a request out.

### Caching and eviction

- It caches a resolve answer for at most 5 s by key and slug (a webhook resolve by address), never a refusal, and drops the entry of a pod that refuses the connection.
- The backend evicts entries at once with `POST /evict` (`{tenantId, slug}`, which also drops that service's webhook resolves, or `{gatewayKey}`, with `x-proxy-control-token`) on the control port 3007, which also serves `/health`. The headless `<release>-external-service-control` Service names every replica, and the backend posts to each address its name resolves to (backend setting `externalServiceProxyControl`, `EXTERNAL_SERVICE_PROXY_CONTROL` = `host:port`, unset = no eviction).
- It evicts the service on its Disable and Delete, a key on its Rotate (and the service too when the key is a service pod's own), and every key of a Project on the Project's disable; a missed replica falls back to the 5 s life.

## Code

- `proxy/internal/gate/` — the `external-service` mode: finding the key, the caller cache, forwarding, the webhook lane, the control port.

## Related

- [Request Flows](request-flows.md) — the edge and the other runtime proxies beside the Gate's.
- [Gate](../external-services/gate.md) — what the backend's resolve endpoint decides for a call.
