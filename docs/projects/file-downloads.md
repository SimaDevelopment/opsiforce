---
kind: explanation
---

# File Downloads

> How does a `/workspace/...` link the Agent posts in chat become a file the browser saves?

## How it works

- The Agent hands over a file by linking its workspace path in a reply, such as `[report.csv](/workspace/report.csv)`; the embedded chat renders an ordinary link.
- A click interceptor over the chat catches `/workspace/...` links: a format the panel renders opens in [File preview](file-preview.md), everything else is fetched from the backend and saved by the browser.
- The backend reads the file straight from the shared workspace volume, so a download works while the pod is asleep and binary files come through untouched ([Persistence](../runtime/persistence.md)).
- Access requires membership of the [Project](../../CONTEXT.md)'s tenant; paths are confined to the environment's workspace, and dotfiles are never served.
- Download lives in the backend files module beside upload and listing; the path guards (traversal and null-byte rejection, per-segment length limit, the dotfile ban, the post-open check that the descriptor resolves inside the workspace) and the extension-to-content-type map are shared helpers parameterised by a per-surface policy.
- The app-builder Agent is instructed to use the plain `/workspace/...` form and no other download affordance.

## Edge cases

- When a link points at a file that no longer exists, the download answers not found.

## Code

- `backend/src/files/download.controller.ts` — attachment-only streaming, tenant-gated.
- `backend/src/files/file-paths.ts` — the shared path guards.
- `frontend/src/components/project/workspace-file-links.tsx` — the click interceptor.
- `agent-config/agents/app-builder/agent.md` — the link instruction to the Agent.

## Related

- [File preview](file-preview.md) — the inline sibling the interceptor opens first.
- [Files](files.md) — the tab whose per-row download reuses this endpoint.
- [Request Flows](../runtime/request-flows.md) — the upload path this mirrors.
