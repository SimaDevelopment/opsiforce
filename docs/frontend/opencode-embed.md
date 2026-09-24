---
kind: explanation
adrs: [0026, 0031, 0067]
---

# OpenCode Embed

> How is OpenCode's chat rendered inside the Opsiforce frontend, and how does it reach the pod through the platform's own auth and proxy?

## How it works

- The frontend imports OpenCode's Solid.js components (`AppBaseProviders`, `AppInterface`) directly: a custom Vite resolver maps `@opencode-ai/*` to the vendored source under `frontend/opencode/`, and the components render inline in the platform SPA.
- The `@/` alias points into the vendored OpenCode tree and `~/` into platform code; the vendored tree is read-only and fixes happen on the consuming side.
- Chat boot runs in a separate Solid render root behind a connecting overlay that is dismissed by observing the DOM, never inside a platform Suspense boundary ([ADR-0026](../adr/0026-chat-boot-suspense-contained-and-covered.md)).
- The embed reaches the pod's OpenCode through `/api/proxy/{environmentId}` like every other client ([Request Flows](../runtime/request-flows.md)); OpenCode v2's Basic auth is injected by agent-control inside the pod, and the embed's fetch adapter repairs the `/api/proxy` prefix the client drops, so no external caller changes ([ADR-0031](../adr/0031-opencode-auth-and-path-prefix-stay-inside-the-platform.md)).
- The platform and the embed share one TanStack QueryClient, and the platform forces the theme; every platform read goes through the store-backed [Query Adapter](query-adapter.md) so refetches never detach the chat's DOM.
- The embed emits a debounced agent-idle signal that reloads the App preview and refetches [Files](../projects/files.md), and a mutation observer over its rendered markdown decorates `/workspace/...` links into file cards ([File preview](../projects/file-preview.md)).
- The chat tab stays mounted after the user switches tabs, so returning to it never reloads the conversation ([Pod Tools](../runtime/pod-tools.md)).
- The same embed is mounted a second time on a [Builder chat](../../CONTEXT.md) at `/store/agents/{id}/builder` and `/store/skills/{id}/builder`, which is carried by a Project like any other and connects to its [Development](../../CONTEXT.md) ProjectEnvironment; it renders the ordinary Project chassis beside its test Project, and the boot, the router and the proxy path are unchanged.
- Every platform helper that reaches into the embed's markup — dictation, file upload, workspace file links, the App preview iframe — is scoped to the host element its own instance rendered into, never to `document`, because two embeds are visible at once on a Builder chat ([ADR-0067](../adr/0067-the-embeds-dom-helpers-are-scoped-to-their-host-element-not-the-document.md)).

## Code

- `frontend/vite-plugins/` — the resolver that maps the OpenCode packages to the vendored source.
- `frontend/opencode/` — vendored, never edited.
- `frontend/src/components/project/project-chat-tab.tsx` — the render root, the overlay and the fetch adapter.
- `frontend/src/pages/store/builder-page.tsx` — the Builder chat page that mounts the same component.
- `proxy/cmd/agent-control/opencode_proxy.go` — Basic auth injection in front of OpenCode.

## Related

- [Query Adapter](query-adapter.md) — why platform reads avoid the stock TanStack adapter.
- [Request Flows](../runtime/request-flows.md) — the agent proxy path the embed uses.
- [Connection](../public-api/connection.md) — how a program reaches the same runtime.
- [Pod Tools](../runtime/pod-tools.md) — the tabs around the chat.
