# Issue tracker: Local Markdown

Issues and PRDs for the opsiforce package live as markdown files in `.scratch/` — there is no GitHub Issues or external tracker workflow for this work.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md` (or `<feature-slug>-prd.md` when kept flat)
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

`.scratch/` is gitignored, so these files are working notes — they do not appear in `git status` or travel between worktrees. Copy them by hand if you switch checkouts.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/issues/` (creating the directory if needed). Do not call `gh issue create` — there is no GitHub tracker for this work.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.
