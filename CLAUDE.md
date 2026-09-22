## Rules

- **Knowledge base** — `docs/` explains how Opsiforce works; [docs/CONVENTIONS.md](docs/CONVENTIONS.md) governs it. Start at [docs/README.md](docs/README.md). Changing behaviour: fix every bullet your diff makes false on its home page, same commit. Adding a page or ADR: use the template there.
- **Agent image version** — `agent-config/agent-image-version.json` is the pod image tag: `yarn dev` skips the build when the tag already exists and running pods keep the old image, so bump it with every change under `docker/Dockerfile.agent` or `agent-config/`. A behaviour change to an agent (prompt, skills, templates, migrations) also bumps that agent's `version` in `agent-config/agents.json`; that is what rolls it out to existing workspaces ([Agent Updates](docs/agent-system/agent-updates.md)).
- **Vendored OpenCode is read-only** — `frontend/opencode/` is upstream source mapped in by the Vite `opencodeResolver`; fix on the consuming side.

## Agent skills

Per-package config for the `to-prd` / `to-issues` skills. `.scratch/` is gitignored.

### Issue tracker

Issues and PRDs live as local markdown under `.scratch/<feature-slug>/` — no GitHub or external tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical defaults (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`); `to-prd`/`to-issues` only use `ready-for-agent`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the opsiforce package root. See `docs/agents/domain.md`.
