# Skills and Agents are Disabled like Projects, not Archived

[ADR-0066](0066-a-builder-chat-is-an-ordinary-project-surface-and-its-test-project-sits-beside-it-in-a-scrolling-strip.md) moved the Builder surface from *Archive* to *Disable* and kept *Archive* for the Store, on the grounds that Disable stops a pod while Archive only hides a catalog entry. In use the split read as two words for one act — taking something out of use, reversibly, while whatever already depends on it carries on — and the Store's menus offered *Archive* and *Restore* beside Project menus offering *Disable* and *Enable*.

**Disable is the one word for taking anything out of use, and Enable the one word for bringing it back — a Project, a Builder chat, a test Project, a Skill and a Custom Agent alike.** Concretely:

- **The column follows the word.** `agents.archived` and `skills.archived` are renamed `disabled` in migration 0070; the rename is a column rename, so every row keeps its state.
- **The routes follow the word.** `POST /agents/:id/archive` and `/restore`, `POST /skills/:id/archive` and `/restore`, and `POST /builder/chats/:id/archive` and `/restore` become `/disable` and `/enable`. The old paths are gone rather than aliased: the only callers are the platform's own frontend and tests, and the public API never exposed them.
- **Every name follows the word.** The Store filter `archived` becomes `disabled`, the response field `archived` becomes `disabled`, and the error codes `skill_archived`, `skill_not_archived` and `agent_not_archived` become `skill_disabled`, `skill_not_disabled` and `agent_not_disabled`.
- **Only the meaning is shared, not the mechanism.** Disabling a Project still stops its pods; disabling a Skill or an Agent still stops nothing and only closes it to new use. The word describes what the person does, not what the platform does underneath.

## Considered options

- **Keep Archive for the Store** (ADR-0066) — rejected by the owner: the difference in mechanism is invisible to the person choosing the action, and two words for one intent is what the glossary exists to prevent.
- **Rename the labels only, keep `archived` in the schema and the API** — rejected: a response field and a route that disagree with the button that calls them leave the next reader to rediscover the synonym.

## Consequences

- Retires ADR-0066's clause that *Archive* narrows to the Store sense; the rest of ADR-0066 stands.
- A bookmarked Store URL carrying `filter=archived` falls back to the default filter.
