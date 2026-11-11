---
kind: explanation
adrs: [0026, 0031, 0067]
---

# OpenCode Embed

> How is OpenCode's chat rendered inside the Opsiforce frontend, and how does it reach the pod through the platform's own auth and proxy?

## How it works

- The frontend imports OpenCode's Solid.js components (`AppBaseProviders`, `AppInterface`) directly: a custom Vite resolver maps `@opencode/*` to the vendored source under `frontend/opencode/`, and the components render inline in the platform SPA. The vendored tree is an upstream release tag copied wholesale, minus upstream's agent instructions; the frontend declares the npm packages it imports and mirrors upstream's Vite settings for the Office previews.
- The `@/` alias points into the vendored OpenCode tree and `~/` into platform code; the vendored tree is read-only and fixes happen on the consuming side.
- Chat boot runs in a separate Solid render root behind a connecting overlay that is dismissed by observing the DOM, never inside a platform Suspense boundary ([ADR-0026](../adr/0026-chat-boot-suspense-contained-and-covered.md)).
- The embed reaches the pod's OpenCode through `/api/proxy/{environmentId}` like every other client ([Request Flows](../runtime/request-flows.md)); OpenCode v2's Basic auth is injected by agent-control inside the pod, so no external caller changes, and the embed's fetch adapter reloads the page when the platform session expires (a 401) instead of letting OpenCode ask for a server URL ([ADR-0031](../adr/0031-opencode-auth-and-path-prefix-stay-inside-the-platform.md)).
- The embed is chat-only: CSS scoped to the chat tab hides OpenCode's own chrome (side region, review toggle, attach button) and every surface its built-in GUI extensions add (terminal dock, narrow-screen view switcher, their slash commands, the debug bar); the chat header keeps timeline search, shows context usage read-only (its click and tooltip only open the hidden side region), and hides Details, a popover of OpenCode's own workspace, git and extension state.
- The platform and the embed share one TanStack QueryClient; every platform read goes through the store-backed [Query Adapter](query-adapter.md) so refetches never detach the chat's DOM.
- The chat takes the shell's look through OpenCode's own theme API ([Design system](design-system.md)): the platform registers a theme under OpenCode's default id `oc-2` — the only id OpenCode keeps when it starts, so nothing is re-stored on each mount — whose palette is the shell's resolved colours and whose overrides point the surfaces, ink, borders and accent the chat paints at the shell's live custom properties, so Contrast and the Appearance seeds reach it too. Its light or dark follows the shell's scheme. The shell's stylesheet wins the page's `color-scheme`, canvas and `theme-color` over what OpenCode writes on `<html>`, so nothing is removed when a chat unmounts.
- More than one [Session](../../GLOSSARY.md) runs in a chat through OpenCode's own title bar: a tab per Session opened in this browser, `+` for a new Session, and Home, which lists every root Session of the environment with search, rename, export and delete. On a narrow screen the tabs fold into a drawer, as OpenCode does. The platform hides what reaches past the environment — Home's project column, Settings and Help, the new-Session wordmark and its folder, worktree and branch pickers — and opens the runtime's default directory as OpenCode's project, so a new Session starts in `/workspace` with the Project's Agent.
- OpenCode keeps open tabs in browser storage and drops those of runtimes it was not given, so a chat starts with only its own environment's tabs. The chat opens on the Session last shown for that environment in this browser while it exists and is not archived, else on the primary one; a first message sent from Project creation opens the primary Session.
- The shell owns Cmd/Ctrl K and Cmd/Ctrl B: the platform sets OpenCode's palette and Home shortcuts to `none`, because OpenCode's capture-phase listener would swallow the keys before the shell's palette and sidebar see them.
- A mutation observer over the embed's rendered markdown decorates `/workspace/...` links into file cards ([File preview](../projects/file-preview.md)).
- The chat tab stays mounted after the user switches tabs, so returning to it never reloads the conversation ([Pod Tools](../runtime/pod-tools.md)).
- Until the embed is connected, the chat area shows one state panel — icon, title, a line of explanation and its actions — for the environment on screen: Starting or Connecting while connect holds, which retries an `environment_starting` answer every 2 s; Disabled with Enable project; Failed with Restart project; Couldn't connect with Try again and Restart project; and an unconfirmed first message with Try again, which resends it under the same id. Enable and Restart show only to holders of their permissions, and Restart recreates that environment's pod ([Pod Lifecycle](../runtime/pod-lifecycle.md)).
- The same embed is mounted a second time on a [Builder chat](../../GLOSSARY.md) at `/store/agents/{id}/builder` and `/store/skills/{id}/builder`, which is carried by a Project like any other and connects to its [Development](../../GLOSSARY.md) ProjectEnvironment; it renders the ordinary Project chassis beside its Test Project, and the boot, the router and the proxy path are unchanged.
- The platform restyles the embed only from outside: `opencode-overrides.tsx` sets OpenCode's own preferences, and `opencode-overrides.css` hides the internals the platform replaces (review toggle, Home's project column, the new-Session pickers) and lets the composer's agent, model and variant pickers shrink so they never cover its Send button.
- Every platform helper that reaches into the embed's markup — dictation, file upload, workspace file links, the App preview iframe — is scoped to the host element its own instance rendered into, never to `document`, because two embeds are visible at once on a Builder chat ([ADR-0067](../adr/0067-the-embeds-dom-helpers-are-scoped-to-their-host-element-not-the-document.md)).

## Code

- `frontend/vite-plugins/` — the resolver that maps the OpenCode packages to the vendored source.
- `frontend/opencode/` — vendored, never edited.
- `frontend/src/components/project/` — the chat tab's render root, overlay and fetch adapter, connect and its state panels, and the `.oc-chat-only` overrides.
- `frontend/src/pages/store/builder-page.tsx` — the Builder chat page that mounts the same component.
- `proxy/cmd/agent-control/opencode_proxy.go` — Basic auth injection in front of OpenCode.

## Related

- [Query Adapter](query-adapter.md) — why platform reads avoid the stock TanStack adapter.
- [Request Flows](../runtime/request-flows.md) — the agent proxy path the embed uses.
- [Connection](../public-api/connection.md) — how a program reaches the same runtime.
- [Pod Tools](../runtime/pod-tools.md) — the tabs around the chat.
