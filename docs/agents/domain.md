# Domain Docs

How the engineering skills should consume the opsiforce package's domain documentation when exploring the codebase.

This is a **single-context** layout: `CONTEXT.md` and `docs/adr/` live at the opsiforce package root (`packages/opsiforce/`), not the monorepo root. Treat the opsiforce package as the context boundary.

## Before exploring, read these

- **`CONTEXT.md`** at the opsiforce package root — the domain glossary.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in (e.g. ADR-0008 "agent model owned by agent-config" before touching the Agent registry).
- Narrative orientation: start at `docs/README.md` (the hub) and `docs/CONVENTIONS.md` (the rules the pages follow); the *why* lives in the ADRs (`docs/adr/README.md`).

If any of these files don't exist, **proceed silently**. Don't flag their absence or suggest creating them upfront. The domain-modeling flow (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure (single-context, opsiforce-scoped)

```
packages/opsiforce/
├── CONTEXT.md            ← domain glossary
├── docs/
│   ├── README.md
│   ├── CONVENTIONS.md
│   ├── agent-system/     ← one folder per subsystem (runtime/, projects/, …)
│   ├── adr/              ← architectural decisions (0001…)
│   └── agents/           ← this directory (skill config)
└── backend/ frontend/ agent-config/ …
```

The monorepo root has no `CONTEXT.md` and no `CONTEXT-MAP.md`; engineering-skill work on opsiforce stays within this package's context.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md` — e.g. **Agent**, **Project**, **ProjectEnvironment**, **go-live**, **agent-config**. Don't drift to synonyms the glossary avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for domain-modeling).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0008 (agent model owned by agent-config) — but worth reopening because…_
