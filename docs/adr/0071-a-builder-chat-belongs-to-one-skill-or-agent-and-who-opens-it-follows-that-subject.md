# A Builder chat belongs to one Skill or Agent, and who opens it follows that subject

[ADR-0064](0064-builder-chats-are-kind-stamped-projects-prompted-by-their-creator-with-pods-that-never-destroy.md) made a Builder chat a free-standing conversation filed in a Store list, [ADR-0065](0065-a-builder-chat-is-private-or-public-and-one-gate-enforces-it-on-every-runtime-surface.md) gave it a visibility of its own, and [ADR-0069](0069-a-builder-chats-subject-is-pod-environment-not-a-first-message.md) told the Builder what it was editing through a file in its workspace. In use the list was a second catalog beside Agents and Skills, a chat could author several things or none, and the author had to find the right chat again rather than the thing they were working on.

**Every Builder chat belongs to exactly one Skill or one Custom Agent — its subject — and a subject has at most one chat. The subject is named in the Store before the chat exists, the chat is reached from the subject's page, and whoever may see the subject may open its chat.** Concretely:

- **The link lives on the subject.** `agents.builder_chat_id` and `skills.builder_chat_id` replace `created_in_chat_project_id`: unique, nullable, `on delete set null`. Opening the Builder on a subject with no chat makes one and claims it with a conditional update, so two first openings settle on one chat and the loser's Project is removed. Migration 0071 keeps, per chat, the earliest entry of the chat's own kind and clears the rest.
- **Naming comes first.** New agent and New skill ask for a name alone and create the entry before the chat: an Agent with an empty Development profile, a Skill with no Version (`latest_version_id` null). The Builder fills in the rest, including the Agent's description, from the conversation. A Skill with no Version cannot be pinned, and is deleted without being disabled first because nothing ever received it.
- **The pod asks, it is not told.** `GET /me` answers `builderSubject` for the gateway key of a chat's pod, so nothing is written into the workspace and the Builder reads the live name and state. `.opsiforce/builder-subject.json` is gone.
- **Reach follows the subject.** `projects.chat_visibility` is dropped. The runtime gate reaches a kind-stamped Project for its creator, or for anyone the governing chat's subject is visible to — public, or private to its creator — so a chat and its test Project widen when their Skill or Agent is made public, and never narrow on their own.
- **The pod gains two verbs.** `PATCH /agents/{id}` joins the public API carrying `displayName` and `description`, and `PATCH /skills/{id}` carrying `displayName`, amending ADR-0064's bound: the Builder settles the one line an author was no longer asked to type and renames its subject on request, both undoable by doing them again, while the slug never changes and every widening or destructive verb stays in the Store.
- **A chat is part of its subject's life.** A chat and its test Project are deleted like any Project, through `DELETE /projects/:id` and the delete permission, and the chat takes its test Project with it; deleting the chat starts the conversation over and leaves the subject as it is, and deleting the subject deletes its chat. A chat is never duplicated or exported, since a copy would belong to nothing.

## Considered options

- **The link on the chat (`projects.subject_agent_id`, `projects.subject_skill_id`)** — rejected: two nullable columns and a check on every Project row, for a fact only the Builder reads; one column per subject table keeps the uniqueness a plain index.
- **Keep chat visibility, defaulting from the subject** — rejected by the owner: two states that can disagree for one piece of work, where the subject's visibility already says who works on it.
- **Create the chat first and the subject on its first publish** — rejected: an unfinished chat would again have nowhere to be found but a list of chats.

## Consequences

- Supersedes ADR-0069. Retires ADR-0065's chat visibility, while its one gate on every runtime surface stands and now asks the subject; ADR-0064's shared chat list and Duplicate (Builder chat); ADR-0066's chat-level visibility entries in the kebab; ADR-0070's `/builder/chats/:id/disable` and `/enable`; and the Builder's own `DELETE /builder/chats/:id` and `/test-project`, so `POST /builder/chats` is its only route. The chat stays a kind-stamped Project with pods that never destroy.
- A chat left without a subject by the migration is reachable only by its creator and appears nowhere in the Store.
- Where one chat had produced several subjects, the migration keeps the link on the earliest and clears it on the rest, which get a fresh chat when next opened; the old conversation stays with the earliest subject.
- A Skill the Builder creates for an Agent it is writing has no chat of its own until someone opens the Builder on it.
