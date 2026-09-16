# Knowledge base conventions

Three layers: `CONTEXT.md` says what each term is, `docs/adr/` says why a decision was made, pages under `docs/<area>/` say how the system works today. First reader is an agent with git access. The promise is one hop: a "how" or "why" question is answered by one file plus at most one more.

## 1. Ownership

A sentence belongs to exactly one layer, decided by the question it answers:

| Question | Layer | File |
|---|---|---|
| What is X? What is X not called? | Glossary | `CONTEXT.md` |
| Why this, and why not the alternative? | Decision record | `docs/adr/NNNN-*.md` |
| How does it work today? What happens when? | Page | `docs/<area>/<page>.md` |

A sentence answering two questions is split, one sentence per layer. Nothing is stated in two layers.

**Decisions on pages.** A decision written as current behaviour is a page sentence with the ADR linked in that sentence; the reasons and rejected options are ADR sentences.

- Page: "App state is pushed from the pod, never polled ([ADR-0015](adr/0015-app-liveness-pushed-not-polled.md))."
- Not on a page: "because polling produced ~141 doomed fetches per unreachable pod."

A rejected alternative on a page ("rather than", "instead of") is ADR material: link the existing ADR, or write one first when the choice passes the ADR test (section 7), or rewrite the sentence to keep the fact and drop the alternative when it fails. One ADR-less rationale sentence per choice is allowed only when the choice fails the ADR test and names no alternative.

**Terms on pages.** Spell every canonical term as `CONTEXT.md` spells it. Link the first use on a page to `CONTEXT.md` (whole file, no anchors); a gist of about a dozen words may ride in the same sentence, never a second definition. Each term has at most one **home page**, which owns its mechanics (how it is created, changed, constrained, what it looks like); a term may be glossary-only. Other pages state what their own flow needs and link the home page. `CONTEXT.md` links no pages and cites no code.

**Terms in ADRs.** A new ADR uses glossary terms verbatim and defines none; a decision that introduces a concept adds the `CONTEXT.md` entry in the same commit. When an old ADR body and `CONTEXT.md` disagree, `CONTEXT.md` is authoritative and the ADR is a dated record; fix by ADR status, never by editing the body.

**Shipped only.** Pages are present tense and describe shipped behaviour: no status banners, planned behaviour, "implemented" markers, or history ("used to be", "previously labelled"). Unshipped designs are `proposed` ADRs or a PRD outside the knowledge base.

**ADR bodies never link pages and are never edited.** Page frontmatter carries the ADR-to-page mapping. Pre-existing ADRs that link pages keep those links, repaired on a page move (section 6).

The rule covers every file under `docs/`, operations pages included.

## 2. Structure

1. **An area is a subsystem.** Every page lives in the folder of the subsystem it explains. `frontend/` and `backend/` are the two layer areas for mechanisms with no subsystem home.
2. **Root holds no pages.** `docs/` contains `README.md` (the hub), this file, and folders.
3. **One hub.** `docs/README.md` is the only index of pages, hand-written: sections in tree order, Operations last, one row per page with a one-clause gist. No per-area README files, no llms.txt.
4. **Operations is a folder.** `docs/operations/` holds how-to and runbook pages (section 3, operations shape).
5. **Explanation and how-to never share a page.** Step lists inside area pages move to their own operations page, linked from the area page. Why-sentences inside operations pages go to ADRs; the operations page keeps one lead paragraph of mechanism with the ADR linked.
6. **Filename.** The home page of one glossary term is named after that term, kebab-case, as `CONTEXT.md` spells it. Any other page is named after its title noun.
7. **No ADR index.** The filename is the index: number and title. `docs/adr/README.md` is a preamble only (section 7).
8. **Assets.** One folder per asset under `docs/assets/<name>/` holding `source.*` (edited) and `render.*` (embedded), never one without the other, each referenced by at least one page or the package README.
9. **`docs/agents/` is not knowledge base.** It holds the mattpocock plugin's skill configuration, committed.
10. **A runnable example is the one non-page thing an area may hold.** `docs/<area>/example/` is a self-contained program with its own `package.json`, linked from the area's pages and from the operations page that verifies it, never listed by the hub.

## 3. Page template

Every `kind: explanation` page has this shape and nothing outside it:

```markdown
---
kind: explanation
terms: [<terms this page is home for>]   # omit when empty
adrs: [<ADRs this page is home for>]     # omit when empty; not every ADR linked in the body
---

# <Glossary term or title noun>

> <One sentence: the question this page answers.>

## How it works

### <Sub-mechanism>             # groups only above 6 bullets

- <One mechanism per bullet. Present tense. First term use linked; a decision carries its ADR link.>

## States                        # only when the mechanism has a lifecycle

<One sentence naming what the states belong to.>

| State | What happens |
|---|---|

## Edge cases                    # only when there are any

- <"When X, Y." One sentence each. Failure paths, fallbacks, skipped work.>

## Code                          # mandatory; section 5

- `<directory/ or file>` — <what this code owns in the mechanism>.

## Related

- [<Page>](path) — <what that page owns that this one only touches>.
```

| Section | Budget |
|---|---|
| Purpose line | 1 sentence, at most 25 words, phrased as the question answered. A page whose purpose cannot be written as a real question is a cut candidate. |
| How it works | at most 16 bullets, 5 `###` groups, 2 sentences per bullet; one figure per page. Over 16 bullets, the page splits. |
| States | at most 8 rows plus 1 intro sentence |
| Edge cases | at most 8 bullets, 1 sentence each |
| Code | at most 6 bullets |
| Related | at most 6 pages, pages only; terms and ADRs live in frontmatter and in-sentence links |

**Operations shape.** Frontmatter `kind: operations` only; title; a one-sentence goal blockquote; `## Prerequisites`, `## Steps`, `## Verify`. Commands and files are named inline in the steps. No budgets, no `## Code`.

## 4. Frontmatter

Frontmatter carries only what cannot be derived from the path, the body, or git. Keys in this order:

| Key | Required | Value | Meaning |
|---|---|---|---|
| `kind` | yes | `explanation` \| `operations` | "how does it work / what happens when" vs "how do I". No other values: code is the reference. |
| `terms` | omit when empty | flow list, e.g. `[Environment, Environment Slug]` | Terms this page is the **home page** for. Not terms it merely links. |
| `adrs` | omit when empty | flow list, e.g. `[0001, 0012]` | ADRs this page is the **home page** for: the one page whose behaviour the ADR shapes. Not every ADR linked. |

1. A `terms` entry is spelled byte for byte as its `**Term**:` line in `CONTEXT.md` and exists there.
2. A term or an ADR number appears in at most one page's block, knowledge-base-wide. A term in no block is glossary-only; an ADR in no block has no home page.
3. `operations` pages carry `kind` only.
4. An empty key is omitted, never `[]`. An `explanation` page whose block is only `kind` owns nothing: the cut-candidate signal.

Both invariants are one grep each. `CONTEXT.md`, `README.md`, `adr/README.md` and this file carry no block; they are not pages.

## 5. `## Code`

A page says "where do I start reading" once, with the most drift-resistant handle that still leads into the code. Handles ranked by drift resistance: glossary term > directory > exported symbol > file path > line number. The consumer greps; behaviour, fields, routes and line numbers are caches of the code and never appear.

Every `explanation` page has a `## Code` section, never empty, before Related. Bullet shape:

```markdown
- `backend/src/publish/` — publish job, worker and stage stream.
- `backend/src/project/project-auth.service.ts` — the App Auth gate configuration, keyed by routing id.
```

1. One literal path per bullet, relative to `packages/opsiforce/`, backticked, then a spaced em dash and one clause saying what the code **owns** in this mechanism. No links, no `./`, no globs.
2. A directory (`backend/src/environment/`) by default; a file or symbol only when the directory name alone would not lead a reader there (`project-auth.service.ts` on the Environments page, because nothing in "environments" points at `project/`). Directories end with `/`; a symbol is `` `Name` in `path` ``; a database table is a symbol, its columns are not.
3. Vendored code (`frontend/opencode/`) is cited as its directory only, marked "vendored, never edited".
4. Order follows How it works. At most 6 bullets; more means the page splits or the module boundary is wrong.

ADR bodies may cite code the same way; a path in an accepted ADR is historically correct rather than stale, and the home page's `## Code` is the live pointer.

## 6. Freshness

The knowledge base is true when no sentence on a page is false about the shipped code. Every pull request that changes behaviour keeps it true: an agent in the commit that changes the code, a human before the pull request is reviewed.

**Before committing, run the false-sentence test.** For every glossary term your diff touches, open its home page (`grep -rlF '<term>' docs/`, or the page whose `## Code` cites the directory you changed). Rewrite every bullet, States row and Edge case the diff made false. Add a bullet for behaviour no bullet covers. Done when nothing on the page is false after the diff.

**Added behaviour** gets a bullet on the existing area page; a new page only when How it works would pass 16 bullets, with a hub row and a frontmatter block. A new concept gets a `CONTEXT.md` entry first. A decision that passes the ADR test gets an ADR and a link from the bullet.

**Changed behaviour** rewrites the bullet. When the change reverses an ADR, write a new ADR and set `status: superseded by ADR-NNNN` on the old one; the bullet links the new ADR.

**Removed behaviour** is a sweep: delete the bullets, or the page with its hub row when nothing is left; delete the `CONTEXT.md` entry; set `status: deprecated` on every ADR whose decision no longer holds. Write a short retirement ADR only when the removal itself passes the ADR test. The retired name lives on in that ADR's title and on the `_Avoid_` line of the replacement term when one exists. No tombstones in `CONTEXT.md`.

**Moved code.** Moving or renaming a directory or file cited in any `## Code` updates that bullet in the same commit; `grep -rF '<old path>' docs/` returns nothing before the commit.

**Moved page.** Moving or renaming a page repairs every link to it in the same commit, hub, pages and ADR bodies alike, with the same grep. A path repair is the only edit an ADR body ever receives; the sentence around the link is not touched.

**Hub.** A new, retired or retitled page edits its hub row by hand. Nothing here runs in CI.

## 7. ADRs

Format, numbering and the three-test filter ("the ADR test": hard to reverse, surprising without context, a real trade-off) are the `domain-modeling` skill's `ADR-FORMAT.md`; `/grilling` and `/domain-modeling` are how ADRs get written. Two additions: a removed feature gets a short retirement ADR under the same test, and a retirement ADR names in its own sentences every earlier ADR whose consequences it retires, because frozen bodies and shipped-only pages leave no other route from the stale text to the correction.

**Status** is the skill's optional frontmatter key, `status: proposed | accepted | deprecated | superseded by ADR-NNNN`, the only mutable thing in an ADR:

1. No block means `accepted`. Every ADR with any other status carries the block; adding it deletes any prose `Status:` line. Parsers read frontmatter, else accepted.
2. No parentheticals, dates or notes in the value. Git holds dates.
3. **Supersession test.** `superseded by` only when a later ADR answers the **same question** with a different answer. A later ADR that retires a consequence, replaces a detail, or builds on an earlier one leaves its status untouched. There is no "amended by".
4. A decision that changes an earlier one is a new ADR, never an edit.
5. Superseded and deprecated ADRs appear in no page's `adrs`. An accepted ADR in no page's `adrs` is a coverage gap.

**Finding ADRs.** There is no table. `ls docs/adr/` lists every decision by number and title; `grep -rl 'NNNN' docs/ --include='*.md'` on page frontmatter finds the home page. `docs/adr/README.md` holds a preamble only: the format, the status rule, the two greps.
