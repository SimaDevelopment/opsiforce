# App identity is read at runtime, not hardcoded by the agent

An app's name lives in `app.meta.json` and has two writers: the agent, which creates the file when the app goes live, and humans, whose Edit-details action writes the file and mirrors it into the `projectApps` row. A browser tab title taken from `index.html` or hardcoded by the agent goes stale after a human rename, and a "keep the title in sync" prompt rule can be silently ignored by the model.

**The web-app starter reads identity at runtime.** `main.tsx` renders an `<AppTitleSync />` component that queries the starter's `/api/app-meta` route (which reads `app.meta.json` fresh on every request) and sets `document.title`; `index.html` points at a fixed `frontend/public/favicon.svg`, shipped as a neutral placeholder. That route is the starter's own convenience; the platform's contract is the file ([ADR-0061](0061-the-platform-harness-is-a-built-in-skill-and-an-agents-prompt-is-the-authors-body-alone.md)). The agent's part lives in skills: `platform` says to write `app.meta.json` as soon as the first feature works and to carry an existing name and description forward unless the user asks to rename; `web-app` says to overwrite the placeholder favicon at go-live with a flat, brand-coloured SVG glyph (letter-mark fallback, no image generation unless asked). Title sync is structural — it cannot drift the way a prompt instruction can.

## Considered options

- **Prompt-enforced sync** — instruct the agent to copy the name into `index.html` and keep it updated. Rejected: it fails silently whenever the model ignores it, and human renames would never propagate without an agent turn.
- **Propagating a Development rename into published environments' files** — writing into published environment directories would mutate git-managed publish state behind the publish path ([ADR-0004](0004-git-based-incremental-publish.md)). Rejected: Edit details writes only the targeted environment's own `app.meta.json` ([ADR-0016](0016-app-details-are-per-environment.md)), and a published App takes Development's name at its next publish.
- **Generated favicons (`gpt-image-2`)** — slower, costs tokens, and raster output turns muddy at 16 px. Rejected as the default; a user can still explicitly ask the agent for a fancier icon.
- **Migrating existing projects** — a managed template migration could additively patch `main.tsx`, `index.html`, and `public/`. Rejected: those files are agent-owned and divergent in existing workspaces, and the feature is not worth the patch risk.

## Consequences

- A human rename via Edit details reaches that environment's tab on the next load or window focus and its preview header immediately; a Development rename reaches a published environment at its next publish.
- `main.tsx`'s `<AppTitleSync />` is declared platform plumbing in the `web-app` skill. The protection is convention — prompt wording plus placement in a file the agent has no reason to rewrite — not enforcement, the same trust model as the rest of the workspace.
- A workspace whose `main.tsx` lacks `<AppTitleSync />` keeps its hardcoded title and has no favicon; nothing patches it.
- The favicon path (`frontend/public/favicon.svg`) is a fixed contract between the starter and the `web-app` skill.
