# Architecture Decision Records

> The durable record of *why* Opsiforce is shaped the way it is. Each ADR captures one decision: its context, the choice, the alternatives rejected, and the consequences. Pages under `../` link here rather than restating rationale.

**Format.** The `domain-modeling` skill's `ADR-FORMAT.md`: a one-line title, one to three sentences of context, decision and reason, optional Considered Options and Consequences. An ADR is written when the choice is hard to reverse, surprising without context, and the result of a real trade-off. A retirement ADR names every earlier ADR whose consequences it retires. Bodies are never edited; a change of mind is a new ADR.

**Status.** `docs/CONVENTIONS.md` § 7. The optional frontmatter key `status: proposed | accepted | deprecated | superseded by ADR-NNNN` is the only mutable thing in an ADR; no block means `accepted`. `superseded by` applies only when a later ADR answers the same question differently.

**Finding an ADR.** There is no table.

- `ls docs/adr/` lists every decision by number and title.
- `grep -rl 'NNNN' docs/ --include='*.md'` finds the page whose frontmatter names the ADR as its home page.
