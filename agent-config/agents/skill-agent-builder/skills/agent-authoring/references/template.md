# The Template, exactly

`template/` at the root of this chat's workspace is the Agent's Development Template in draft. A save
makes the Template an exact copy of it; every new Project of the Agent then starts with those files
at the root of its own workspace, as its first commit.

A Template lives in `template/` and only there: an `app/startup.sh` at this workspace's root would
become this chat's own App. `scripts/check-template.sh` is the only thing that runs a Template — on a
copy and a spare port, stopping what it started (§Check before every save).

## What may go in one

Anything every Project should start with that the child would otherwise re-create or re-fetch:
files it runs, files it reads, and files its output is built from. Material the child reads goes in
`reference/`; input data it loads goes in a folder of its own, such as `examples/`; a save leaves out
any folder named `data/`.

Any `app/startup.sh` makes the Template an App: every Project of it runs under the App contract the
`platform` skill states.

## Limits

A save **leaves out**, and lists under `skipped` with a reason:

- files opencode would load beside the body — `AGENTS.md` at any depth, a root `opencode.json` or
  `opencode.jsonc`, `.claude/` and `.agents/`;
- platform folders (`.git/`, `.opencode/`, `.opsiforce/`, `.xdg/`), installed dependencies and
  package-manager state, any `data/`, caches, `user_uploaded_files/`, `generated_files/`, and
  whatever the Template's own `.gitignore` files exclude.

A save **refuses**, and saves nothing: symlinks, `app/opsiforce.env.json`, `app/app.meta.json`, and
`.env*` files other than `*.example`. Key-like strings are saved but listed under `warnings`: tell the
author, and move a real secret to the Environment's settings. There is no size cap.

## Drafting

`template/` is laid at a Project's root: `template/app/` becomes `/workspace/app/`, `template/reference/`
becomes `/workspace/reference/`.

- **A starter snapshot** is a full copy of App Builder's starter, which you then edit in place. Only
  then pin `web-app` and its stack Skills:

  ```sh
  mkdir -p template && cp -a /opt/agents/app-builder/template/app template/app && rm -rf template/app/data
  ```

- **Another stack** is a skeleton you write yourself — `startup.sh` first, then the fewest files that
  run — and run before you save (below).
- **Files the author brings** arrive through the chat's upload bar in `user_uploaded_files/`. Copy
  each into `template/` and say where it went. A file dropped into the prompt box never reaches the
  workspace: ask the author to use the upload bar instead.
- **Reference material** goes in `template/reference/`, and the body names each path the child uses.

## Check before every save

Choose the check by what changed:

- **No `template/`** — nothing to check.
- **Only files that do not run** — every path the body names exists in `template/`, and each file
  opens with the tool the child will use on it.
- **Something that runs** — a boot check on a copy, with the first-time setup the body or its Skills
  tell the child to run:

  ```sh
  sh scripts/check-template.sh '<first-time setup>'   # or no argument when there is none
  ```

  It syncs `template/` into `.cache/template-check/`, keeping what the setup installed there, runs the
  setup, starts `app/startup.sh` in development on a spare port, waits for any HTTP answer and stops
  everything it started. On a failure it exits non-zero with the log tail. With no `app/startup.sh` it
  runs the setup and reports "nothing to boot".

  When the change touches `startup.sh` or what its production branch builds, run it once more with
  `--production`: `sh scripts/check-template.sh --production`. It boots a fresh copy of only what git
  would track, with no setup and no installed dependencies, under `OPSIFORCE_ENV=production`, the way
  Publish (App) does.

Your pod runs the child's image, so what the check finds installed, the child has too. Whatever the
Template needs beyond the image, the Template ensures itself: `app/startup.sh` for an App, and
otherwise the first-time setup the body names, installing into `/workspace` (a venv,
`.cache/<tool>-<version>`) idempotently, so it can run before every use.

Install and build only in the check's copy, so `template/` holds only what a Project starts with. A Template that is broken
does not fail the test visibly: the child quietly repairs it in the Test Project, the run looks green,
and every real Project starts broken.

## Save

Stop anything that writes into `template/`, then save. There is no body: the folder is the input.

```sh
A=$(sh scripts/api.sh call GET /me | jq -r .builderSubject.id)
sh scripts/api.sh call PUT "/agents/$A/template" | jq '{hash, files: (.files | length), skipped, warnings}'
```

- **200** — the `hash`, the saved `files` (path, size, executable), the `skipped` paths with reasons
  and the `warnings`. A missing or empty `template/` removes the Template (`hash: null`). Then take
  the snapshot the next check compares against: `sh scripts/template-snapshot.sh save`.
- **422 `template-refused`** — one `errors[]` item per refused path. Fix every one, then save again.
- **409 `template-changed`** — `template/` changed during the copy. Stop what is writing and save again.

Saving the same files again gives the same `hash`, so save whenever you are unsure what Development
holds. `GET /agents/{id}` shows `template: { hash }` (or `null`) on each profile; a Production hash
that differs from Development's means Production is behind until someone publishes.

## When `template/` changed without you

The author can edit `template/` from the Code tab between your turns. Before every check and every
save, list what differs from the last save:

```sh
sh scripts/template-snapshot.sh diff   # one line per file: A added, M changed, D deleted
```

With no snapshot yet, `template/` holds the saved Template (a Duplicate's, or one saved before
snapshots existed): take one with `save` before your first edit. A difference you did not make is the
author's edit, and the author's edit is kept:

- **By default, keep it.** Build on it as the author left it, go no further than it goes, and name it
  in your report.
- **The check fails on it** — put the saved file back with
  `sh scripts/template-snapshot.sh restore <path>…`, so the Template keeps working, and add it to the
  one question below.
- **It contradicts a requirement the brief states** — add it to the one question below.

The one question lists each such edit, what it conflicts with, and the choice *keep*, *complete* or
*revert*. Ask it before you save, and save once the author answers.

## Later starter changes

A starter snapshot never moves on its own. Only when the author asks: merge App Builder's current
starter into `template/` without undoing the Agent's own changes, re-pin `web-app` and its stack
Skills to their latest Versions, then check, save and test. Never suggest it unprompted.
