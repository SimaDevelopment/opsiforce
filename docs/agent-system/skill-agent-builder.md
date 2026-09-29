---
kind: explanation
terms: [Skill & Agent Builder, Builder chat, chat kind]
adrs: [0064, 0066]
---

# Skill & Agent Builder

> How a Skill's or a Custom Agent's Builder chat authors it, and who is allowed to open it?

## How it works

### The chat

- The [Skill & Agent Builder](../../CONTEXT.md) is a Built-in Agent with `poolSize` 0 and `platformApi: true`, reached from a Skill's or a Custom Agent's page rather than from a project workspace. Its package ships the `skill-authoring` and `agent-authoring` skills and a template with no `app/`, so its pod idles with no App of its own. Of the shared skills it carries only `platform`, `web-app` (whose stack table decides a starter snapshot's pins) and `agent-browser` (to look at a child's App); `package-skills.json` excludes the rest, and it reads what a child can get from `GET /skills?filter=built_in`.
- A [Builder chat](../../CONTEXT.md) belongs to exactly one Skill or Custom Agent, its subject, and a subject has at most one chat: `agents.builder_chat_id` and `skills.builder_chat_id` hold the link, unique and cleared when the chat goes ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- New agent and New skill ask only for a name, create the entry — an Agent whose Development profile holds an empty prompt and the `platform` Skill, a Skill with no Version — and open its chat. Opening the Builder from the entry's page later returns the same chat, and the first opening of one that has none makes it; two first openings settle on one chat.
- The chat is a `kind`-stamped Project. The stamp keeps it out of every workspace, the project list and `GET /api/v1/projects`, while `GET /projects/{id}` still answers for whoever may open it ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)). [chat kind](../../CONTEXT.md) follows the subject and picks which authoring skill opens the conversation.
- The pod learns its subject from `GET /me`'s `builderSubject`, then reads the Agent or the Skill's latest Version itself. It writes an Agent's Development profile, its Skills, its display name and its `description`, and saves its Development Template from the `template/` folder at its workspace root ([Template](template.md)); it publishes a Skill's Versions, the first included, under the name the author gave, sets a Skill's display name and duplicates a Skill.
- For an Agent, the Builder decides from the brief whether its Projects start from a [Template](../../CONTEXT.md) and never asks the author a technical question about it. It places each thing by one rule — files the Project owns go in the Template, know-how read when needed in a Skill, identity and the rules every Project keeps in the body — and gives an Agent that runs an App a short **Architecture** section of rules to keep. Anything used in a browser starts from a snapshot of App Builder's starter copied into `template/` and edited there, which takes later starter changes only when the author asks; another stack starts from a skeleton the Builder writes and runs, never from a Skill describing one ([ADR-0073](../adr/0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)).
- The author may edit `template/` from the chat's Code tab. After every save the Builder snapshots `template/` into `.cache/template-saved/` with `scripts/template-snapshot.sh`, and before every check and save it lists what differs. An author's edit is kept; the Builder asks one question only when an edit contradicts a requirement the brief states or fails the check, and restores a file the check failed on ([ADR-0073](../adr/0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)).
- The pod holds a `platform-api` [Gateway Key](../public-api/api-token.md) as well as its `service` one and calls the public API as an [Agent Caller](../public-api/api-token.md): it acts as the human who opened the chat and reaches only Projects that pod created, which it may also restart and delete ([ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)). On Skills and Agents it has only the reversible verbs: it never deletes, disables, publishes an Agent or makes anything public ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- A chat is never deleted on its own: it lives as long as its subject, so its draft `template/` is never lost, and deleting the subject deletes its chat. The chat page and the Project kebab offer no Delete (or Disable) for a chat, while `DELETE /projects/{id}` itself is unchanged. A chat is never duplicated or exported ([ADR-0073](../adr/0073-a-custom-agents-template-is-a-folder-per-environment-copied-into-every-new-project.md)).
- Opening an Agent's chat for the first time passes the subject into the create, and when the Agent already has a Development Template — from a Duplicate, an Import or an earlier chat — delivery lays it into the chat's `template/` before the pod starts, so the first save builds on it instead of wiping it. A create that loses the race to claim the subject's `builder_chat_id` is discarded with its workspace and its copy.
- The chat page renders the ordinary Project chassis — the Chat/Files/Code/DB tabs and the Project kebab, minus the Environments popover, Move, Duplicate and Export on a kind-stamped Project — with the chat and its Test Project as panes of one horizontal strip of columns that scrolls when they no longer fit; each pane opens a preview column when it has an App or file preview, and every column resizes from its right edge, its width saved per pane role ([ADR-0066](../adr/0066-a-builder-chat-is-an-ordinary-project-surface-and-its-test-project-sits-beside-it-in-a-scrolling-strip.md)). There is one pane until a Test Project exists, and a disabled one keeps its pane, whose own kebab enables, renames or deletes it; the chat itself has no rename. The chat's pod is what creates the Test Project and publishes what it made, so the backend republishes the chat Project's event stream after any successful write from that pod and the page refetches there rather than polling.
- The chat's one [Test Project](../../CONTEXT.md) is where it tries what it wrote: the Builder creates it on the Agent's Development, converses with it, checks its record and refreshes it after each round of fixes ([Test Project](test-project.md)). A Skill chat publishes and reads back; its Skill is tried in the chat of an Agent that carries it, once that Agent re-pins the new Version ([ADR-0063](../adr/0063-the-builder-tests-a-child-agent-by-conversing-with-it-in-one-throwaway-project.md)).

### Who may open it

- Whoever may see the subject, and holds the permission matching it, may open its chat: its creator while it is private, the whole Organization once it is public ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- One predicate enforces that on every by-id path. The API answers **404** so the route is indistinguishable from a chat that does not exist, while the runtime proxy's ensure hop answers **403** on the agent surface; the Code and DB surfaces do not run it ([ADR-0064](../adr/0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- A chat of a public subject is writable — two people may prompt it — and its [Test Project](../../CONTEXT.md) follows the same subject rather than carrying a state of its own.

## Edge cases

- When a chain would go deeper than two — a Builder chat's child creating its own child — no `platform-api` key is minted, so the grandchild is not an Agent Caller.
- When the subject is disabled, its existing chat still opens, but a subject with none gets no new one until it is enabled. The chat's kebab offers no Disable, though `POST /projects/:id/disable` does not refuse a chat, and opening the Builder on an enabled subject turns a disabled chat back on.
- When the Builder writing an Agent creates a Skill that Agent needs, the Skill has no chat of its own until someone opens the Builder on it.
- When a chat has no subject, it is reachable by its creator alone and appears nowhere in the Store.

## Code

- `backend/src/builder/` — opening a subject's chat, the claim, the subject a pod reads and the chat's one Test Project.
- `backend/src/public-api/auth/` — the Agent Caller guard, the chat-events interceptor and the caller's chat Project.
- `agent-config/agents/skill-agent-builder/` — the Builder's prompt, its authoring skills, the test-loop reference and the pod template.
- `frontend/src/pages/store/builder-page.tsx` — the chat page: the bar back to its subject, the pane strip and the chat's kebab entries.
- `frontend/src/components/ui/pane-strip.tsx` — the scrolling strip of panes, its snap stops and its scroll arrows.

## Related

- [Custom Agents](custom-agents.md) — what the Builder authors, and the Profile it edits.
- [Skill](skills.md) — the Versions the Builder publishes and the gate it validates against.
- [API Token](../public-api/api-token.md) — the Gateway Key and Agent Caller the pod authenticates with.
- [Test Project](test-project.md) — the one Project each chat tests its subject in, and its Update and Reset.
