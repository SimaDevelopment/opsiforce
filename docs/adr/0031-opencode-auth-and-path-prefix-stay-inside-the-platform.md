# OpenCode v2 auth and path prefix are handled inside the platform, not by its callers

OpenCode v2 enforces HTTP Basic auth on every route, including `/api/info`, the username is fixed to `opencode`, and the server refuses to start without a password. The pod has four unauthenticated callers: kubelet probes, the platform nginx proxy, the backend, and the browser's event stream through the platform proxy. Handing each a credential would spread a secret to four places, put it in browser memory, and change every probe and proxy config.

Instead `opencode2 serve` binds `127.0.0.1` on an internal port, and agent-control, which already runs in the pod with the control token, exposes the historical port as a reverse proxy that injects the `Authorization` header (`proxy/cmd/agent-control/opencode_proxy.go`). The entrypoint derives `OPENCODE_PASSWORD` from `OPSIFORCE_CONTROL_TOKEN`, so no new secret exists. From outside the pod nothing changed: same port, same paths, no credential. The proxy flushes unbuffered because the event stream is SSE.

A second seam sits in the browser: auth-expiry handling. The embed reaches the pod through the platform proxy under the user's oauth2-proxy session, so when that session expires the proxy answers 401, and opencode would replace the chat with its "connect server" screen. The embed supplies a `Platform.fetch` that reloads the page on a 401 instead, the same as the platform's own API client (`frontend/src/components/project/platform.tsx`), so the user signs in again and lands back in the chat. The generated client keeps the `/api/proxy/<envId>` path prefix the platform routes on, so `Platform.fetch` rewrites no URLs. Two places still drop the prefix: the attachment upload builds `/api/experimental/fs/write` from the server origin and sends it over `XMLHttpRequest`, so pasted or dropped files opencode cannot inline fail and the platform's upload button is the supported path; and the request queue matches full pathnames, so behind the prefix it caps nothing. PTY websockets are not repaired; the embed never surfaces the terminal.

Two smaller v2 facts shape the embed's connection code (`frontend/src/components/project/use-opencode-connection.ts`): sessions are listed with `parentID=null` because v2 returns an enveloped, cursor-paginated list, and a session is always created before the embed mounts because v2 has no directory-scoped draft route.

## Considered options

- **Give every caller the password.** Rejected: four copies of a secret, one of them in the browser, and every probe and proxy definition changes.
- **Patch the vendored client to respect path prefixes.** Rejected: vendored opencode is never modified; upstream fixes arrive through the normal bump.
- **Run opencode with the platform proxy authenticating on its behalf.** Rejected: the proxy sits outside the pod and would need per-pod credentials; agent-control already holds the pod's token.

## Consequences

- The pod boundary is identical to v1 for every external caller; v2 auth is an implementation detail of the pod.
- A future "open a terminal" feature needs the websocket prefix problem fixed upstream or a second rewrite.
- An expired session costs the user one page reload, never a screen asking for a server URL.
- Attachment upload by paste or drop and the request queue stay degraded behind the prefix until upstream fixes them.
