# Issue tracker: Local Markdown

Issues and PRDs for the opsiforce package live as markdown files in `.scratch/` — there is no GitHub Issues or external tracker workflow for this work.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md` (or `<feature-slug>-prd.md` when kept flat)
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

`.scratch/` is **tracked in this package** — a `!/.scratch/` + `!/.scratch/**` pair in `.gitignore` overrides the ignore rules elsewhere. Specs and tickets appear in `git status`, travel into worktrees, and are committed alongside the code they describe: commit a ticked checklist with the work it describes. Every other package keeps `.scratch/` ignored, so copy by hand there. If an implementation session sees this negation as an "unrelated" diff, it must leave it alone — it is shared infrastructure, not scope creep.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/issues/` (creating the directory if needed). Do not call `gh issue create` — there is no GitHub tracker for this work.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.
