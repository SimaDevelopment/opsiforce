# Commands Reference

> Day-to-day dev commands for Opsiforce — type-check, lint, database, local ports. For first-time setup and the run loop, the [Quickstart](../quickstart.md) (`yarn dev`) is canonical.

Setup and the run loop are one command — `yarn dev` (the [Quickstart](../quickstart.md)). This page covers the commands you run *while* developing, once the stack is up.

## Type check, lint, format

Opsiforce TS/JS uses the Rust-based [OXC](https://oxc.rs) toolchain — **oxlint** + **oxfmt**, not ESLint/Prettier. Config lives at `.oxlintrc.json` (shared base, extended per package) and `.oxfmtrc.json`. Run per workspace (swap `@opsiforce/backend` for `@opsiforce/frontend`):

```bash
yarn workspace @opsiforce/backend run ts        # tsc type-check
yarn workspace @opsiforce/backend run lint       # one pass: applies safe autofixes, errors fail, warnings advisory
yarn workspace @opsiforce/backend run format      # oxfmt rewrite (append --check for a CI dry run)
yarn workspace @opsiforce/backend run check       # lint && ts — the pre-commit gate
yarn workspace @opsiforce/backend run test        # Vitest; needs Docker (see [Testing](testing.md))
```

`lint` is a single stack-tuned pass: the backend runs type-aware rules (`oxlint-tsgolint`) plus the `node`/`import`/`promise` plugins; the frontend runs `jsx-a11y` plus Solid and solid-query rules via oxlint `jsPlugins` (auto-discovered from `frontend/oxlint.config.ts`). The vendored `frontend/opencode/` tree is excluded.

## Database

```bash
yarn workspace @opsiforce/backend run db:generate --name <meaningful-name>   # migration from schema changes
yarn workspace @opsiforce/backend run db:migrate                             # apply migrations
yarn workspace @opsiforce/backend run db:studio                              # Drizzle Studio (localhost:4983)
```

**Always give `db:generate` a meaningful `--name`** describing the change (`add-session-id-to-projects`, not `update`). Generic names make migration history unreadable.

## Testing the backend API directly

With the Tilt port-forward up, the backend answers on `localhost:3010`, e.g. `curl http://localhost:3010/api/health` or `/api/projects`.

## Local ports

| Service | URL / Port |
|---|---|
| Opsiforce app (via Traefik) | `https://opsiforce.localtest.me` |
| App / VS Code / DB per project | `https://{env}.{apps,code,db}.opsiforce.localtest.me` |
| Bifrost dashboard · Tilt UI | `https://{bifrost,tilt}.opsiforce.localtest.me` |
| Backend (Tilt port-forward) · Node debug | `localhost:3010` · `:9229` |
| Frontend (Vite HMR) | `localhost:8084` |
| PostgreSQL · Redis · Keycloak | `localhost:5435` · `6382` · `8086` |
| Drizzle Studio · Mailgun mock | `localhost:4983` · `8089` |

## Local environment notes

- `backend/local-envs.sh` and `frontend/local-envs.sh` hold local bootstrap vars (backend/Bifrost; app/preview/VS Code/DB domains).
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are optional locally; omitted, Bifrost provider secrets are created empty (calls to those providers won't work until real keys are supplied).
- Local dev builds the agent image into minikube (`AGENT_CONTAINER_IMAGE_PULL_POLICY=Never`); prod uses `Always`.

## See also

- [`../README.md`](../../README.md) — prerequisites and the run loop.
- [Deployment](deployment.md) — CI/CD and the cluster rollout.
