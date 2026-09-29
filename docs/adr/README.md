# Architecture Decision Records

> The durable record of *why* Opsiforce is shaped the way it is. Each ADR captures one decision: its context, the choice, the alternatives rejected, and the consequences. Pages under `../` link here rather than restating rationale.

**Format.** The `domain-modeling` skill's `ADR-FORMAT.md`: a one-line title, one to three sentences of context, decision and reason, optional Considered Options and Consequences. An ADR is written when the choice is hard to reverse, surprising without context, and the result of a real trade-off. An ADR states its decision as it holds today: a changed decision is rewritten in place, a removed one is deleted, and git keeps the history.

**Status.** `docs/CONVENTIONS.md` § 7. Frontmatter `status: proposed` marks a decision not built yet; no block means accepted, which describes what the code does.

**Finding an ADR.** There is no table.

- `ls docs/adr/` lists every decision by number and title.
- `grep -rl 'NNNN' docs/ --include='*.md'` finds the page whose frontmatter names the ADR as its home page.
