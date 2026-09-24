---
status: superseded by ADR-0071
---

# A Builder chat's subject is a file in its workspace, not a first message and not a column

[ADR-0064](0064-builder-chats-are-kind-stamped-projects-prompted-by-their-creator-with-pods-that-never-destroy.md) ruled that the backend never originates a prompt, so **Edit with Builder** rendered a seed sentence — *"Let's work on the Agent `test` (id …). Read its Development profile first, then ask me what to change."* — and had the browser send it as the author's own first message. It worked and it read as noise: a message the author did not write, a turn spent on a read the Builder would have done anyway, a question back to someone who came to say what they wanted, and a state lost on a reload before the send.

**What a Builder chat was opened to edit is written by the platform into the chat's own workspace at create, as `.opsiforce/builder-subject.json`; the chat opens empty and the Builder reads the file as part of answering the author's first real message.** Concretely:

- At create, when the request carries a seed, the delivery writer that already lays the chat's skills also writes `{"agent":{"id","name"}}` or `{"skill":{"id","name"}}` to `/workspace/.opsiforce/builder-subject.json`. The workspace is durable, so the subject survives every pod recreate and every resume; `.opsiforce/**` is read-only to the agent, so it cannot be edited from the chat.
- The Builder's prompt says: when the file exists, read it and then the Skill or Agent it names before answering the first message, work on it unless the author says otherwise, and do not announce the read. No file means a fresh chat.
- `seedPrompt` leaves the create response and the browser stops navigating with a prompt search parameter. Nothing is added to the chat row and no new column exists; the page shows no subject chip, because the Builder's first reply names what it is editing.
- ADR-0064's rule stands and is stronger for it: the backend now originates nothing at all.

## Considered options

- **Two nullable columns on the chat row, handed to the pod as `OPSIFORCE_BUILDER_SUBJECT`** — built first and withdrawn by the owner the same day: correct, but it stored as a database fact something whose only reader is the agent in that workspace, for a chip the Builder's own reply already provides.
- **A hidden first message** — the vendored opencode build has no "no reply" flag on the prompt route and no client-side synthetic part, so anything sent is a visible user message that costs a reply turn: the seed sentence again.
- **The seed only in the pod environment at create, stored nowhere** — the first pod knows it; a resumed chat gets a fresh pod and does not.
- **Keep the seed and shorten it** — rejected: the sentence was not too long, it was a message nobody wrote.
