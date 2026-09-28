# A Builder chat is an ordinary Project surface, and its Test Project sits beside it in a scrolling strip

A Builder chat has a workspace, a pod and a transcript like any Project, and its Test Project is something the author wants to watch while talking to the Builder. A bespoke page would hide surfaces the chat has, and swapping one pane between the two would hide one of them.

**The Builder page renders the ordinary Project chassis for the chat and for its Test Project, laid out as a horizontal strip of columns that scrolls when they no longer fit.**

- **One chassis, gated by condition.** `ProjectView`, `ProjectHeader` and `ProjectActionsMenu` serve both panes, with the full tab set (Chat, Files, Code, DB) under its usual permission and router gates. No `kind` prop is threaded through `ProjectView`. The header and the menu read the Project's own `kind` and drop what cannot apply to a kind-stamped row: Move, since the row has no workspace; the Environments popover; and Duplicate and Export, since a chat belongs to its subject and a Test Project is thrown away on the next run. A chat also offers no Disable.
- **A strip of columns, not a splitter.** Each pane's chat column and preview column sit side by side in one horizontally scrolling strip. Every column resizes from its right edge, and its width persists in the browser for that pane's role. The strip snaps to column starts, shows chevrons on hover-capable pointers and swipes on touch. Column minimums are clamped to the strip's width, so on a phone the same component becomes a swipe deck.
- **One pane until there is a Test Project.** Most chats never start a test, and a Skill chat often has nothing to test. The pod creates the Test Project through the API, not the reader through a button, so an empty second pane would advertise an action nobody performs.
- **Static labels.** A bar above the strip names the subject, with its type icon, a Disabled badge when it is disabled, and a link back to its page. The chat pane reads *Builder*. The test pane reads the Test Project's title and is renamed from its own kebab.
- **The preview belongs to its pane.** A pane shows a preview column exactly as any Project does. The first time the Test Project's preview opens, the strip scrolls once to bring that pane fully into view.
- **Scroll position is not restored.** The strip always opens on the chat. Column widths are a preference; where the reader had scrolled to is state, and restoring it would land a reload on the Test Project with the chat off-screen.
- **The Store's section tabs are hidden on the Builder page**, which gives the strip the full width.
- **`ProjectHeader` resolves its Project by id.** Lists never contain kind-stamped rows ([ADR-0064](0064-a-builder-chat-is-a-kind-stamped-project-that-belongs-to-one-skill-or-agent-and-who-opens-it-follows-that-subject.md)), so the header reads `GET /projects/:id` through `useProject`, a `createAppQuery` hook ([ADR-0043](0043-read-queries-go-through-createappquery-not-the-stock-tanstack-adapter.md)).
- **A composer note shows until the first prompt.** It says what the Builder does here and what stays on the subject's page.

## Considered options

- **A resizable splitter, two panes always summing to the available width.** Rejected. When the panes stop fitting it can only make both too narrow, and it has no way to say "I am looking at the Test Project now".
- **A shared page-level header with one kebab over both panes.** Rejected. It is ambiguous about which Project an action applies to, in a layout whose point is that both are visible.
- **A focused-pane model, where only the focused pane shows its kebab.** Rejected. It hides actions behind a click and invents a pattern that exists nowhere else in this frontend.
- **Auto-collapsing the app sidebar when the second pane opens.** Rejected. It moves chrome the reader did not ask to move.
- **Threading a `kind` prop through `ProjectView` to fork the chassis.** Rejected. Each suppression has its own reason on the row, and a fork would invite hiding the next thing for no reason.

## Consequences

- Two `ProjectView`s are visible at once, which exposes any document-scoped helper around the embed. [ADR-0067](0067-the-embeds-dom-helpers-are-scoped-to-their-host-element-not-the-document.md) scopes them to their host element.
- A Builder chat has no rename in the UI. Its title is set when it is made.
