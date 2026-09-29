---
name: web-app
description: Use when building or changing an App on the platform's web-app starter — the React, Vite, Tailwind and shadcn/ui frontend with a NestJS and SQLite backend laid in `/workspace/app`. Covers the dev servers that are already running, adding packages, the build order, the project structure, the frontend-to-backend flow, the starter's rules, and how to verify the App before calling a feature done. Load it before touching the app.
---

# Building on the web-app starter

`/workspace/app` is the platform's web-app starter: a Vite + React + Tailwind + shadcn/ui frontend, a NestJS backend on SQLite, one `startup.sh` that satisfies the App contract, and a process supervisor. Everything below is true because of that starter. The `platform` skill owns what is true of every App — the contract, the durable workspace, the databases — and nothing here repeats it.

## The starter is already there

`app/` holds the starter — `startup.sh`, `frontend/` and `backend/`. If it does not, stop and tell the user what you found instead of building.

## What the starter fixes and what you change

The starter is a reference structure, not a finished design: it settles the decisions an App would otherwise make differently every time, and leaves the App itself to you.

**Fixed — platform plumbing, never edited:** `startup.sh` stays the entry point, keeps its production and development branches, and runs every process under `guard` (add to it; follow the `platform` skill's rules for what you add). `frontend/hmr-toggle.ts` and its entry in `vite.config.ts`, `<AppTitleSync />` in `main.tsx`, the `/api` proxy, and the health and app-meta routes in `app.controller.ts`. The top-level shape — `frontend/`, `backend/`, `data/`, `startup.sh` — stays.

**Yours to extend — the normal work:** pages, components, backend modules, migrations, packages, and more supervised processes in `startup.sh` when the App needs them.

**Replaceable, only on a decision:** a layer of the starter — the database, a backend library, the styling system — changes only when your own instructions or a skill you carry name the replacement, or the user asks for it outright. Fitting a feature into the starter comes before replacing part of it. A replacement is complete: the old layer's code and package go, and this skill's lines and the stack skill about that layer stop applying, so the App never runs two of anything.

When instructions disagree, the order is: the `platform` skill, then your own instructions, then a skill you carry that names a starter decision it changes, then this skill.

## The dev servers are already running

The container entrypoint runs them through `startup.sh` as soon as dependencies are installed (it waits for `.pnp.cjs`), so on a fresh Project they come up a few seconds after your first `yarn install`.

- **Frontend** (Vite): `http://localhost:3000` — hot-reloads on file save
- **Backend** (NestJS): `http://localhost:3100` — auto-restarts on file change
- Vite proxies `/api/*` to the backend automatically
- The supervisor restarts a crashed service on its own

**Never start, stop or restart them yourself.** No `yarn dev`, no `node backend/src/main.ts`, no command that starts a server. They pick up your changes as you save. Check the backend with `curl http://localhost:3100/api/health` when you need to.

## Adding a package

`cd /workspace/app && yarn add <pkg>`, then **wait a few seconds**: the platform bounces Vite once so it sees the new dependency. Import it after the reload.

Resolve errors right after `yarn add` are transient — wait for the reload and re-check. Never fix them in `vite.config.ts`: `optimizeDeps.exclude`/`include` forces extra restarts and makes things worse.

If an error **persists** — `X tried to access Y, but it isn't declared in its dependencies`, or `Could not resolve 'Y'` inside `.yarn/__virtual__/…` — it is a Yarn PnP gap: a library using an undeclared dependency. Declare it in `/workspace/app/.yarnrc.yml`, then `yarn install`:

```yaml
packageExtensions:
  "<package>@*":
    dependencies:
      "<missing-dep>": "*"
```

## App configuration

The `platform` skill owns the `app/opsiforce.env.json` contract. In this starter, read it in the backend with a helper loaded once at boot:

```ts
import fs from "node:fs"
import path from "node:path"

const file = path.resolve(process.cwd(), "opsiforce.env.json")
const values: Record<string, string> = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {}

export const appConfig = (key: string): string | undefined => values[key]
```

Then `appConfig("STRIPE_API_KEY")` — never `.env`, never `process.env` for the app's own config.

## The build order

1. **Before writing any code**, `cd /workspace/app && yarn install`. Not optional: nothing runs without installed dependencies.
2. **MANDATORY: load the `frontend-design` skill before writing any UI code** — call `skill({ name: "frontend-design" })`. Do not skip this. It holds the design system, the palettes and the anti-patterns. Every App gets a brand colour and a theme of its own, never generic gray defaults; update the variables in `index.css`. If you do not carry `frontend-design`, say so — the author can add it.
3. **Check for an existing App** — `cat /workspace/app/app.meta.json 2>/dev/null`. If it exists, modify what is there.
4. **Build, in this order:**
   - **`pages/home.tsx` is the App.** Rewrite it with the real functionality. It is never a landing page that links to the real content.
   - **Layout** in `App.tsx` — nav links, branding, colours. It is pre-configured with BrowserRouter, Layout and routes: build on it, do not rewrite it.
   - **Database** — migration files in `backend/src/migrations/` (load `sqlite` when you carry it, unless the database was replaced — §What the starter fixes).
   - **Backend API** — a NestJS module per feature (load `nestjs-api` when you carry it). **Register every module in `app.module.ts`** — the single most common mistake.
   - **Frontend** — shadcn + Tailwind for the UI (load `ui` when you carry it), TanStack Query for every request (load `data-fetching` when you carry it).
   - **More pages only when the App genuinely has several views** — a file in `pages/`, a `<Route>` and a `<NavLink>` in `App.tsx`. A simple App is one page.
5. **The two cheap gates before go-live:** `cd /workspace/app && yarn check` (type errors do not crash the boot, so nothing else catches them), then confirm the dev servers booted (§Verifying the App runs).
6. **Go live: write `app/app.meta.json`** as soon as the first feature is built and step 5 passes, per the `platform` skill's go-live rules; feature testing in step 7 runs with the App already live.
   - The tab title is read from that file at runtime — never hardcode the App's name in `index.html`.
   - **Create the favicon at the same moment:** overwrite `frontend/public/favicon.svg` with a flat SVG on the brand colour that shows what the App does — a few basic shapes, or the Lucide icon you chose for the UI. No clear glyph: the App name's initial as a letter mark. No image generation for a favicon unless asked.
7. **Walk the real user flow in the browser before saying a feature is done** (the `platform` skill's browser walk). Go-live already happened, so a problem found here is fixed forward with the App up.

## Frontend to backend

**Every request goes through TanStack Query** — never raw `fetch()` or `axios` in a component. `data-fetching`, when you carry it, has `useQuery`/`useMutation`, query keys, cache invalidation and optimistic updates.

```
User clicks "Save" → React form (ui, rules/forms.md)
  → useMutation calls fetch("/api/...", { method: "POST", body: ... })
    → NestJS Controller receives the request (nestjs-api)
      → Service inserts into SQLite (sqlite)
    → useMutation.onSuccess invalidates cache
  → useQuery refetches → UI updates automatically
```

The frontend talks to the backend at `/api/...`; Vite proxies it.

## Project structure

```
app/
  app.meta.json              — YOU CREATE THIS after the gates pass (go-live; the tab title reads its name at runtime)
  startup.sh                 — the App contract, already satisfied; add anything else the App runs here
  frontend/public/
    favicon.svg               — neutral placeholder; overwrite with a brand-coloured SVG at go-live
  frontend/src/
    App.tsx                   — ROOT COMPONENT (BrowserRouter + Layout + routes pre-configured)
    main.tsx                  — entry point (QueryClientProvider + tab-title sync from app.meta.json — keep both intact)
    index.css                 — Tailwind theme + CSS variables
    pages/home.tsx            — placeholder; becomes the App on the first request
    pages/                    — further page components
    components/ui/            — shadcn components (~21 pre-installed: button, card, input, badge, dialog, alert-dialog, sheet, dropdown-menu, select, command, popover, tooltip, tabs, label, textarea, switch, checkbox, separator, skeleton, alert, avatar)
    lib/utils.ts              — cn() helper
  backend/src/
    main.ts                   — NestJS bootstrap
    app.module.ts             — root module — REGISTER ALL NEW MODULES HERE
    app.controller.ts         — health + app-meta endpoints
    database/                 — DatabaseService (global, inject anywhere)
    external-services/        — catch-all doorbell stub (501); add a route per inbound service you implement
    items/                    — example CRUD module (replace with your own)
    migrations/               — SQL migration files (auto-run on startup)
  data/
    app.db                    — the App's data (tables you create via migrations)
data/
  database.db                 — platform logs: HTTP requests, process output, events (read-only)
```

New pages, components, modules and migrations go inside these directories — that is what they are for. Do not add top-level directories or files beside them, and do not move what is there.

## Skills for this stack

Each of these is a separate skill. Load it when the App needs it **and you carry it**; when you do not carry one the App needs, say so — the author can add it.

| Skill | When |
|---|---|
| `frontend-design` | **First**, before any UI — brand colours, typography, layout, polish |
| `ui` | Any frontend work — shadcn/ui, react-hook-form + zod, the app shell, routing and URL-synced lists, icons, theme tokens, dark mode, command palette, accessibility |
| `data-fetching` | Every request — useQuery, useMutation, invalidation, optimistic updates |
| `nestjs-api` | Endpoints, modules, services |
| `sqlite` | Tables, migrations, queries, transactions, FTS, JSON |
| `agent-browser` | Walking the App in a headless browser to verify a feature |
| `react-table` | Sortable, filterable, paginated tables |
| `charts` | Charts and dashboards (Recharts) |
| `state-management` | Shared client state — Zustand |
| `animations` | Transitions, gestures, reveals |
| `dates` | Formatting, parsing, timezones, pickers |
| `react-dropzone` | Drag-and-drop uploads |
| `dnd-kit` | Drag and drop, kanban, reorderable lists |
| `data-export` | CSV, JSON, print, clipboard |
| `virtual-list` | Lists of 100+ items |
| `websockets` | Live updates, chat, presence |
| `document-generation` | Word, PowerPoint, Excel, PDF deliverables |
| `llm-api` | AI features through the gateway — chat, structured output, transcription, speech, images |

## The starter's rules

1. **No landing pages.** The first page a user sees does the job; "Welcome to X" with a link is never it.
2. **No placeholders.** Every file holds complete, working code. No `// TODO`, no "implement later".
3. **Data lives in the App's database through the backend API**, never in `localStorage`. Auth tokens are the one exception.
4. **No monolithic files.** Split large components; each NestJS feature has its own module folder.
5. **Mobile first.** Design at phone width and scale up with responsive Tailwind classes.
6. **Complete files.** When you edit a file, write the whole updated file.

## Verifying the App runs

After any round of edits, and again before telling the user a feature is done: `cd /workspace/app && yarn check` first, then confirm the dev servers booted — no crash or error lines in the last couple of minutes, and `curl http://localhost:3100/api/health` answers 200. The crash and error queries are in the `platform` skill (§Verify the App booted).

Right after `yarn add`, **wait for the frontend to restart** before checking: `app-frontend` restarts once (one stop/`started` pair and a fresh `VITE ... ready` line). That single restart is the dependency reload. Only a *repeating* restart loop (`restart_count` climbing) or an error that outlives the reload means something is wrong.

Check `app_requests` only when you changed frontend-to-backend communication (a new endpoint, a changed request or response shape).
