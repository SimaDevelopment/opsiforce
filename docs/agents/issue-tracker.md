# Issue tracker: Local Markdown

Issues and PRDs for the opsiforce package live as markdown files in `.scratch/` — there is no GitHub Issues or external tracker workflow for this work.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md` (or `<feature-slug>-prd.md` when kept flat). A charted feature may instead have a `MAP.md` at its root, with the build spec one level down in `build/PRD.md`.
- Implementation issues are `<PRD's directory>/issues/<NN>-<slug>.md`, numbered from `01`. `research/` and `assets/` next to them hold notes the issues link to.
- Issues carry their state as `Key: value` lines, plain or bold (`**Status:**`); read either form:
  - `Status:` the triage role string (see `triage-labels.md`), or the closed marker below
  - `Blocked-by:` or `Blocked by:` links to the issues that must close first, or `None`
  - Wayfinder issues also put `Type:` (`wayfinder:grilling`, `wayfinder:task`, …) and `Assignee:` in a header under the `#` title. Build issues from `to-tickets` use bold `**What to build:**` / `**Blocked by:**` sections instead.
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

`.scratch/` is **gitignored** and lives only in the main checkout (`/Users/oleh/Work/sima/packages/opsiforce/.scratch/`). Git never brings it into a worktree, and nothing in it is committed. In a worktree, `packages/opsiforce/.scratch` should be a symlink to the main checkout's copy (`ln -s /Users/oleh/Work/sima/packages/opsiforce/.scratch <worktree>/packages/opsiforce/.scratch`). Without it, a relative `.scratch/...` write silently creates a separate copy inside the worktree, which no other session sees; if the link is missing, use the absolute main-checkout path.

- Repo-wide Grep/Glob skip gitignored files, so pass the `.scratch/...` path explicitly or use `ls`/`cat` on it.
- A link inside an issue that stays inside `.scratch` (`../PRD.md`, `../../assets/...`) resolves against the issue's main-checkout path. A link that leaves `.scratch` (`../../../../docs/adr/...`, source files) means that path in your own worktree, because issues change those files.

## Closing an issue

Set its status line to `Status: closed (<YYYY-MM-DD>)` and tick every checklist box the work met. An issue is closed when its work is merged into the branch the spec is being built on, not when it is pushed or reviewed. A closed issue stays in place; never delete or move it. When re-running a spec, treat an issue whose branch is already merged into the integration branch as done even if it isn't closed yet, so the run resumes where the last one stopped.

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/issues/` (creating the directory if needed). Do not call `gh issue create` — there is no GitHub tracker for this work.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## When a skill says "close" or "resolve" an issue

Follow **Closing an issue** above. There is no PR to merge and nothing to push.
