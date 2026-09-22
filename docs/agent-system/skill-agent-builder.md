---
kind: explanation
terms: [Skill & Agent Builder, Builder chat, chat visibility, chat kind, test Project]
adrs: [0063, 0064]
---

# Skill & Agent Builder

> How a Builder chat authors a Skill or a Custom Agent, tests what it wrote, and who is allowed to open it?

## How it works

### The chat

- The [Skill & Agent Builder](../../CONTEXT.md) is a Built-in Agent with `poolSize` 0 and `platformApi: true`, reached from the Store's Builder surface rather than from a project workspace. Its package ships the `skill-authoring` and `agent-authoring` skills and a template with no `app/`, so its pod idles with no App of its own.
- A [Builder chat](../../CONTEXT.md) is a `kind`-stamped Project. The stamp is what keeps it out of every workspace, the project list and `GET /api/v1/projects`, while `GET /projects/{id}` still answers for whoever may open it ([ADR-0064](../adr/0064-builder-chats-are-kind-stamped-projects-prompted-by-their-creator-with-pods-that-never-destroy.md)).
- [chat kind](../../CONTEXT.md) — Skill or Agent — is chosen when the chat is started. It picks which authoring skill opens the conversation and which list the chat files under, and never limits what the chat may go on to author.
- The pod holds a `platform-api` [Gateway Key](../public-api/api-token.md) as well as its `service` one and calls the public API as an [Agent Caller](../public-api/api-token.md): it acts as the human who created the chat, reaches only Projects that pod created, and may create and edit but never delete a Skill, archive anything or make anything public ([ADR-0062](../adr/0062-a-pod-calls-the-platform-api-as-the-human-who-created-its-project-bounded-to-what-it-created.md)).
- The chat is where unfinished work lives: nothing half-written is stored anywhere else, so archiving a chat keeps its workspace while destroying its pods, and deleting it tombstones the directory together with its test Project.

### Who may open it

- [chat visibility](../../CONTEXT.md) is **private** by default and flipped only by the creator; unlike a Skill or an Agent it flips back, because a chat publishes nothing by being shared ([ADR-0065](../adr/0065-a-builder-chat-is-private-or-public-and-one-gate-enforces-it-on-every-runtime-surface.md)).
- Every permission holder sees a private chat **listed** — title, kind, creator, what it produced — and cannot open it. The list is an Organization property; the transcript is not.
- One gate enforces that on every runtime surface. The API answers **404** so the route is indistinguishable from a chat that does not exist, while the runtime proxy's ensure hop answers **403** on the agent surface (vscode and db are deferred) ([ADR-0065](../adr/0065-a-builder-chat-is-private-or-public-and-one-gate-enforces-it-on-every-runtime-surface.md)).
- A public chat is writable — two people may prompt it — and its [test Project](../../CONTEXT.md) inherits the state rather than carrying one of its own.

### Testing what it wrote

- A test Project is a throwaway Project the Builder creates on the [Custom Agent](custom-agents.md) it authored, from that Agent's Development [Agent Profile](custom-agents.md), so the child runs the definition as it stood at that moment ([ADR-0063](../adr/0063-the-builder-tests-a-child-agent-by-conversing-with-it-in-one-throwaway-project.md)).
- `kind: "test"` on create is accepted **only** from a Builder chat's own pod; anywhere else it is refused. One is live per chat: a create deletes the predecessor, so exactly one test Project exists at a time.
- The Builder converses with the child through the public API's Connection and then checks the child's claims itself, because the child's transcript is the thing under test: files, the App's database and boot records over the test Project's shell, and the page with the Builder's **own** `agent-browser` pointed at the child's App, which its pod reaches directly (the screenshot lands in the Builder's workspace, where it can read it). It writes its expectations to `scratch/` before the run and grades machine-checkable ones by running their commands; taste is left to the author, who has the test Project's preview beside the chat.
- Because a test Project is created from Development, it is single-use: [Dynamic Delivery](dynamic-delivery.md) freezes the definition at creation, so testing an edit needs a new one.
- The chat page carries a toggle that switches in place between the transcript and the test Project's own view. The chat's pod is what creates the test Project and publishes what it made, so the backend republishes the chat Project's event stream after any successful write from that pod and the page refetches there rather than polling.

## Edge cases

- When a chain would go deeper than two — a Builder chat's child creating its own child — no `platform-api` key is minted, so the grandchild is not an Agent Caller.
- When a Builder chat is opened from a Store deep link, the client sends the rendered seed prompt as the first message once the environment is running; a reload in between leaves an empty chat the author deletes.
- When a plain **New Skill** or **New Agent** chat is started, it opens empty — a seed prompt exists only for the deep link.
- When the author archives a chat, its test Project survives; restoring the chat boots a pod again on the same workspace.
- When the Builder's pod resumes, the hidden-kind exclusion means it cannot find its test Project by listing; it resumes from the note it wrote in `scratch/` plus a read by id.

## Code

- `backend/src/builder/` — the chat rows, the kind predicates, visibility and the supersede-on-create delete.
- `backend/src/public-api/auth/` — the Agent Caller guard, the chat-events interceptor and the caller's chat Project.
- `agent-config/agents/skill-agent-builder/` — the Builder's prompt, its authoring skills, the test-loop reference and the pod template.
- `frontend/src/pages/store/builder-chat.tsx` — the chat page, the produced chips and the test-Project toggle.

## Related

- [Custom Agents](custom-agents.md) — what the Builder authors, and the Profile it edits.
- [Skill](skills.md) — the Versions the Builder publishes and the gate it validates against.
- [API Token](../public-api/api-token.md) — the Gateway Key and Agent Caller the pod authenticates with.
- [Dynamic Delivery](dynamic-delivery.md) — why a test Project reports on the definition it was created with.
