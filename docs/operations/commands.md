---
kind: operations
---

# Commands

> Run the day-to-day checks, database tasks and local services while the stack is up.

## Prerequisites

- A running local stack from the [Quickstart](quickstart.md).

## Steps

1. Type-check, lint and format per workspace (swap `@opsiforce/backend` for `@opsiforce/frontend`). Opsiforce uses the OXC toolchain, oxlint and oxfmt, configured in `.oxlintrc.json` and `.oxfmtrc.json`:

   ```bash
   yarn workspace @opsiforce/backend run ts        # tsc type-check
   yarn workspace @opsiforce/backend run lint      # one pass: safe autofixes, errors fail, warnings advisory
   yarn workspace @opsiforce/backend run format    # oxfmt rewrite (append --check for a dry run)
   yarn workspace @opsiforce/backend run check     # lint && ts, the pre-commit gate
   yarn workspace @opsiforce/backend run test      # Vitest; needs Docker
   ```

   The backend lint runs type-aware rules plus the `node`, `import` and `promise` plugins; the frontend runs `jsx-a11y` plus Solid and solid-query rules from `frontend/oxlint.config.ts`. The vendored `frontend/opencode/` tree is excluded. The test suite is described in [Testing](../backend/testing.md).
2. Database tasks, always with a meaningful `--name` for a migration (`add-session-id-to-projects`, not `update`):

   ```bash
   yarn workspace @opsiforce/backend run db:generate --name <meaningful-name>
   yarn workspace @opsiforce/backend run db:migrate
   yarn workspace @opsiforce/backend run db:studio      # Drizzle Studio on localhost:4983
   ```

3. Call the backend directly through the Tilt port-forward, for example `curl http://localhost:3010/api/health` or `/api/projects`.
4. Reach local services at these addresses:

   | Service | URL / Port |
   |---|---|
   | Opsiforce app (via Traefik) | `https://opsiforce.localtest.me` |
   | App / VS Code / DB per environment | `https://{env}.{apps,code,db}.opsiforce.localtest.me` |
   | Bifrost dashboard · Tilt UI | `https://{bifrost,tilt}.opsiforce.localtest.me` |
   | Backend (Tilt port-forward) · Node debug | `localhost:3010` · `:9229` |
   | Frontend (Vite HMR) | `localhost:8084` |
   | PostgreSQL · Redis · Keycloak | `localhost:5435` · `6382` · `8086` |
   | Drizzle Studio · Mailgun mock | `localhost:4983` · `8089` |

5. Local environment notes: `backend/local-envs.sh` and `frontend/local-envs.sh` hold local bootstrap variables; `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are optional locally, and without them the Bifrost provider secrets are created empty; local dev builds the agent image into minikube with `AGENT_CONTAINER_IMAGE_PULL_POLICY=Never` while production uses `Always`.

## Verify

- `yarn workspace @opsiforce/backend run check` and the frontend equivalent pass.
- `curl http://localhost:3010/api/health` answers.
