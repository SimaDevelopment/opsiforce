---
kind: explanation
terms: [Skill & Agent Builder, Builder chat, chat kind, test Project]
adrs: [0063, 0064, 0066, 0071]
---

# Skill & Agent Builder

> How a Skill's or a Custom Agent's Builder chat authors it, tests what it wrote, and who is allowed to open it?

## How it works

### The chat

- The [Skill & Agent Builder](../../CONTEXT.md) is a Built-in Agent with `poolSize` 0 and `platformApi: true`, reached from a Skill's or a Custom Agent's page rather than from a project workspace. Its package ships the `skill-authoring` and `agent-authoring` skills and a template with no `app/`, so its pod idles with no App of its own.
- A [Builder chat](../../CONTEXT.md) belongs to exactly one Skill or Custom Agent, its subject, and a subject has at most one chat: `agents.builder_chat_id` and `skills.builder_chat_id` hold the link, unique and cleared when the chat goes ([ADR-0071](../adr/0071-a-builder-chat-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- New agent and New skill ask only for a name, create the entry — an Agent with an empty Development profile, a Skill with no Version — and open its chat. Opening the Builder from the entry's page later returns the same chat, and the first opening of one that has none makes it; two first openings settle on one chat.
- The chat is a `kind`-stamped Project. The stamp keeps it out of every workspace, the project list and `GET /api/v1/projects`, while `GET /projects/{id}` still answers for whoever may open it ([ADR-0064](../adr/0064-builder-chats-are-kind-stamped-projects-prompted-by-their-creator-with-pods-that-never-destroy.md)). [chat kind](../../CONTEXT.md) follows the subject and picks which authoring skill opens the conversation.
- The pod learns its subject from `GET /me`'s `builderSubject`, then reads the Agent or the Skill's latest Version itself. It writes an Agent's Development profile, its Skills and its `description`; it publishes a Skill's Versions, the first included, under the name the author gave.
- The pod holds a `platform-api` [Gateway Key](../public-api/api-token.md) as well as its `service` one and calls the public API as an [Agent Caller](../public-api/api-token.md): it acts as the human who opened the chat, reaches only Projects that pod created, and may create and edit but never delete, rename, disable or make anything public ([ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)).
- Deleting the chat starts the conversation over and takes its test Project with it, leaving the subject as it is; deleting the subject deletes its chat. A chat is never duplicated or exported.

### Who may open it

- Whoever may see the subject, and holds the permission matching it, may open its chat: its creator while it is private, the whole Organization once it is public ([ADR-0071](../adr/0071-a-builder-chat-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)).
- One gate enforces that on every runtime surface. The API answers **404** so the route is indistinguishable from a chat that does not exist, while the runtime proxy's ensure hop answers **403** on the agent surface (vscode and db are deferred) ([ADR-0065](../adr/0065-a-builder-chat-is-private-or-public-and-one-gate-enforces-it-on-every-runtime-surface.md)).
- A chat of a public subject is writable — two people may prompt it — and its [test Project](../../CONTEXT.md) follows the same subject rather than carrying a state of its own.

### Testing what it wrote

- A test Project is a throwaway Project the Builder creates on the [Custom Agent](custom-agents.md) it authored, from that Agent's Development [Agent Profile](custom-agents.md), so the child runs the definition as it stood at that moment ([ADR-0063](../adr/0063-the-builder-tests-a-child-agent-by-conversing-with-it-in-one-throwaway-project.md)).
- `kind: "test"` on create is accepted **only** from a Builder chat's own pod; anywhere else it is refused. One is live per chat: a create deletes the predecessor, so exactly one test Project exists at a time.
- The Builder converses with the child through the public API's Connection and then checks the child's claims itself, because the child's transcript is the thing under test: files, the App's database and boot records over the test Project's shell, and the page with the Builder's **own** `agent-browser` pointed at the child's App, which its pod reaches directly (the screenshot lands in the Builder's workspace, where it can read it). It adds its expectations to one file per Agent in `scratch/` before each run, keeps that file across runs, and grades every machine-checkable line in it by running its command, so a change that breaks what passed before fails; taste is left to the author, who has the test Project's preview beside the chat.
- Because a test Project is created from Development, it is single-use: [Dynamic Delivery](dynamic-delivery.md) freezes the definition at creation, so testing an edit needs a new one.
- Once the child's App is live the Builder restarts the test Project's pod through `POST /projects/{id}/restart` — open to the Agent Caller like the other Project routes — and re-runs the serving and data checks, because a recreated container keeps only `/workspace` and an App that does not come back has a `startup.sh` that ensures too little ([ADR-0068](../adr/0068-a-custom-agent-names-a-starter-and-the-web-app-know-how-is-a-skill-both-kinds-build-from.md)).
- The chat page renders the ordinary Project chassis — the Chat/Files/Code/DB tabs, the environments popover and the Project kebab — with the chat and its test Project laid out as a two-pane strip that scrolls when the panes no longer fit ([ADR-0066](../adr/0066-a-builder-chat-is-an-ordinary-project-surface-and-its-test-project-sits-beside-it-in-a-scrolling-strip.md)). There is one pane until a test Project exists, and a disabled one keeps its pane, whose own kebab enables, renames or deletes it. The chat's pod is what creates the test Project and publishes what it made, so the backend republishes the chat Project's event stream after any successful write from that pod and the page refetches there rather than polling.

## Edge cases

- When a chain would go deeper than two — a Builder chat's child creating its own child — no `platform-api` key is minted, so the grandchild is not an Agent Caller.
- When the subject is disabled, its existing chat still opens, but a subject with none gets no new one until it is enabled. A chat is never disabled on its own: its kebab offers no Disable, and opening the Builder on an enabled subject turns a disabled chat back on.
- When the Builder writing an Agent creates a Skill that Agent needs, the Skill has no chat of its own until someone opens the Builder on it.
- When a chat has no subject, it is reachable by its creator alone and appears nowhere in the Store.
- When the Builder's pod resumes, the hidden-kind exclusion means it cannot find its test Project by listing; it resumes from the note it wrote in `scratch/` plus a read by id.

## Code

- `backend/src/builder/` — opening a subject's chat, the claim, the subject a pod reads and the supersede-on-create delete.
- `backend/src/public-api/auth/` — the Agent Caller guard, the chat-events interceptor and the caller's chat Project.
- `agent-config/agents/skill-agent-builder/` — the Builder's prompt, its authoring skills, the test-loop reference and the pod template.
- `frontend/src/pages/store/builder-page.tsx` — the chat page: the bar back to its subject, the pane strip and the chat's kebab entries.
- `frontend/src/components/ui/pane-strip.tsx` — the two-pane strip, its divider and its scroll arrows.

## Related

- [Custom Agents](custom-agents.md) — what the Builder authors, and the Profile it edits.
- [Skill](skills.md) — the Versions the Builder publishes and the gate it validates against.
- [API Token](../public-api/api-token.md) — the Gateway Key and Agent Caller the pod authenticates with.
- [Dynamic Delivery](dynamic-delivery.md) — why a test Project reports on the definition it was created with.
