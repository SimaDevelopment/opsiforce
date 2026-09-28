# Chat boot runs in its own Solid render root behind a connecting overlay

opencode's `AppInterface` has no `Suspense` boundary at its router root and gates its session content with fallback-less `<Show>`s, so boot suspension escapes to whatever ancestor boundary the host provides. In the embed that is TanStack Router's route boundary, which unmounts the whole `/projects/$projectId` match — header, tabs, preview panel — until opencode finishes booting.

**`ProjectChatTab` mounts the opencode subtree with `render()` into a host div, a separate Solid render root, and covers the pane with a "Connecting…" overlay until the composer paints.** Suspension cannot cross roots, so the project chrome is never blanked, and opencode gets the same no-foreign-boundary environment it has in upstream's standalone app. **Nothing platform-side may await opencode's stores or place a `Suspense` above `AppInterface`.**

## The render root

Two timing details are load-bearing:

- **The root is created one macrotask after mount** (`setTimeout(0)`). Solid transitions are global to the runtime, not per root; a root created while the platform's route transition is still pending gets its boot captured by that transition and deadlocks on client-side navigation with cold persistence.
- **The embed's inputs are captured once per mount.** `server`, `serverKey`, `router` and the title-sync callback are snapshotted when `ProjectChatTab` mounts; the embed root is not reactive to platform props. An environment switch unmounts the component (the connection hook resets its router to null), which disposes the root and re-arms everything for the new environment.

Inside the embed root:

- `OpenCodeEventBridge` (preview reload on session idle, title sync) and `OpencodeOverrides` are children of `AppInterface`, above opencode's route-level server providers, so `useServerSDK()` is unavailable to them. They resolve the server context through `useGlobal().ensureServerCtx(server)`, read untracked because the whole root is recreated rather than updated when the connection changes.
- Hooks needing platform context (`useSyncProjectTitle`) are called in `ProjectChatTab` itself and handed into the root as closures — the embed root has no access to the platform app's contexts.

## Covering the boot gap

The pane is bare from mount until the composer paints. A "Connecting…" spinner overlaid on the pane covers it, so the user sees one continuous spinner from the pre-router "Connecting…" state to the painted chat.

Dismissal is passive DOM observation: a `MutationObserver` on the embed host fires until a composer element (`[contenteditable="true"]` or `textarea`) exists, then the overlay lifts after a double `requestAnimationFrame`, so the frame that removes the spinner is one where the chat is already painted. A 15-second timeout bounds the coupling to opencode's DOM shape: if an upstream bump changes the composer markup, the spinner lifts late instead of stranding. Observer and timeout are cleaned up on unmount.

## Considered options

- **A local `Suspense` around the embed** — rejected: it contains the blank but deadlocks opencode's cold boot. With no opencode persistence in localStorage (first visit, new browser, cleared site data), opencode's boot navigates its memory router and writes its persisted tab store inside `startTransition`, and under a foreign suspended `Suspense` boundary those transitions never commit. The composer renders but the event stream never opens and messages never load until a reload. Warm boots resolve synchronously from persistence and never suspend, so the failure looks intermittent.
- **A readiness overlay that awaits `sync.session.lineage.resolve(sessionId)`** — rejected: calling into opencode's sync store from outside races its own bootstrap and causes the same intermittent dead boots.

## Consequences

- The surrounding project chrome stays painted while the embed boots behind the platform's connecting overlay, on cold and warm profiles, full page loads and client-side navigations.
- Cold-profile reproduction for any regression: `localStorage.clear()` on the opsiforce origin, then open a project — and test full page load and client-side navigation from home separately, as they fail independently.
- No vendored edits: everything lives in opsiforce's embed layer, so an opencode upgrade does not have to re-apply patches.
