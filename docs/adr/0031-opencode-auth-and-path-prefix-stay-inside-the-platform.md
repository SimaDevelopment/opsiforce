# OpenCode v2 auth and path prefix are handled inside the platform, not by its callers

OpenCode v2 enforces HTTP Basic auth on every route, including `/api/health`, the username is fixed to `opencode`, and the server refuses to start without a password. The pod has four unauthenticated callers: kubelet probes, the platform nginx proxy, the backend, and the browser's event stream through the platform proxy. Handing each a credential would spread a secret to four places, put it in browser memory, and change every probe and proxy config.

Instead `opencode2 serve` binds `127.0.0.1` on an internal port, and agent-control, which already runs in the pod with the control token, exposes the historical port as a reverse proxy that injects the `Authorization` header (`proxy/cmd/agent-control/opencode_proxy.go`). The entrypoint derives `OPENCODE_PASSWORD` from `OPSIFORCE_CONTROL_TOKEN`, so no new secret exists. From outside the pod nothing changed: same port, same paths, no credential. The proxy flushes unbuffered because the event stream is SSE.

A second seam sits in the browser. v2's generated client builds every request as `new URL('/api/…', baseUrl)`, which discards the `/api/proxy/<envId>` path prefix the platform routes on (upstream anomalyco/opencode#46498). The embed supplies a `Platform.fetch` that reattaches the prefix for same-origin `/api/*` and the client's legacy `/global/health` probe (`frontend/src/components/project/platform.tsx`). PTY websockets are not repaired; the embed never surfaces the terminal.

Two smaller v2 facts shape the embed's connection code (`frontend/src/components/project/use-opencode-connection.ts`): sessions are listed with `parentID=null` because v2 returns an enveloped, cursor-paginated list, and a session is always created before the embed mounts because v2 has no directory-scoped draft route. The Vite config stubs `virtual:vite-opencode-picker/client`, a desktop-only module the dev-server dependency scanner trips over although the web bundle never imports it.

## Considered options

- **Give every caller the password.** Rejected: four copies of a secret, one of them in the browser, and every probe and proxy definition changes.
- **Patch the vendored client to respect path prefixes.** Rejected: vendored opencode is never modified; the `Platform.fetch` hook is the supported seam.
- **Run opencode with the platform proxy authenticating on its behalf.** Rejected: the proxy sits outside the pod and would need per-pod credentials; agent-control already holds the pod's token.

## Consequences

- The pod boundary is identical to v1 for every external caller; v2 auth is an implementation detail of the pod.
- A future "open a terminal" feature needs the websocket prefix problem fixed upstream or a second rewrite.
- If upstream ever drops the `/global/health` probe, the extra branch in the fetch override can go.
