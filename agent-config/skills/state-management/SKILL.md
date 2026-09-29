---
name: state-management
description: Client-side state management with Zustand — global stores, selectors, useShallow, middleware (persist, devtools, immer) and the slices pattern. Use for shared UI state across components — filters, selections, sidebar/modal state, shopping cart, undo history, drag state, multi-step wizard state, anything read or written by more than one component. Do NOT use for server data (use data-fetching) or URL-synced state (use useSearchParams from react-router). Load whenever a component needs state that isn't local to it.
---

# State Management

Zustand for client-side shared state, written against major v5. Already installed in the template (no `yarn add` needed).

**Why Zustand:** zero boilerplate, no providers, ~1 KB, first-class TypeScript, selectors prevent unnecessary re-renders. For this template's app-builder workloads it's the right default; reach for `data-fetching` for server data and `useSearchParams` for URL-synced filters.

## Quick start — TypeScript store

Use `create<T>()()` — double parentheses (see Issue #1 for why).

```ts
import { create } from "zustand"

interface BearStore {
  bears: number
  increase: (by: number) => void
}

const useBearStore = create<BearStore>()((set) => ({
  bears: 0,
  increase: (by) => set((state) => ({ bears: state.bears + by })),
}))
```

## Use in components

Always select the specific slice you need — this is what stops unnecessary re-renders:

```tsx
const bears = useBearStore((state) => state.bears)        // re-renders only when bears changes
const increase = useBearStore((state) => state.increase)  // function reference is stable
```

## Core patterns

**Counter store:**

```ts
interface CounterStore { count: number; increment: () => void }
const useStore = create<CounterStore>()((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}))
```

**Persistent store — UI preferences only** (theme, collapsed panels, last tab). App data lives in the database through the backend (`web-app`), never in `persist`:

```ts
import { persist, createJSONStorage } from "zustand/middleware"

const useStore = create<UserPreferences>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "user-preferences",
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
```

## Critical rules

**Always:**
- Use `create<T>()()` (double parentheses) in TypeScript (Issue #1)
- Define separate interfaces for state and actions
- Use selector functions to extract specific state slices
- Use `set` with updater functions for derived state: `set((state) => ({ count: state.count + 1 }))`
- Use unique `name` values for each persist-middleware store
- Use `useShallow` when selecting multiple values into one object
- Keep actions pure — no side effects beyond state updates

**Never:**
- Use `create<T>(...)` (single parentheses) — Issue #1
- Create new objects in selectors: `useStore((state) => ({ a: state.a }))` — Issue #3
- Mutate state directly: `set((state) => { state.count++; return state })` — always return a new object (or use immer)
- Reuse a persist `name` across stores — causes data collisions
- Use Zustand for server data — use `data-fetching` (TanStack Query) instead
- Export the store instance directly — always export the `useStore` hook

## Known issues this prevents

### Issue #1: TypeScript double parentheses missing

**Error:** Type inference fails, `StateCreator` types break with middleware.

**Why:** The currying syntax `create<T>()()` is required for middleware to work with TypeScript inference.

```ts
// WRONG — single parentheses
const useStore = create<MyStore>((set) => ({ /* ... */ }))

// CORRECT — double parentheses
const useStore = create<MyStore>()((set) => ({ /* ... */ }))
```

**Rule:** Always use `create<T>()()` in TypeScript, even without middleware (future-proof).

### Issue #2: Persist middleware import error

**Error:** `Attempted import error: 'createJSONStorage' is not exported from 'zustand/middleware'`

**Why:** Wrong import path or v4↔v5 version mismatch.

```ts
// CORRECT for v5
import { create } from "zustand"
import { persist, createJSONStorage } from "zustand/middleware"
```

### Issue #3: Infinite render loop

**Error:** `Maximum update depth exceeded.` Browser freezes.

**Why:** Creating a new object reference inside the selector. Zustand sees a new reference on every render and re-renders, which creates another new reference, etc. Zustand v5 surfaces this immediately (v4 silently degraded).

```tsx
import { useShallow } from "zustand/shallow"

// WRONG — new object every render
const { bears, fishes } = useStore((state) => ({
  bears: state.bears,
  fishes: state.fishes,
}))

// CORRECT — option 1: select primitives separately
const bears = useStore((state) => state.bears)
const fishes = useStore((state) => state.fishes)

// CORRECT — option 2: useShallow for multi-value select
const { bears, fishes } = useStore(
  useShallow((state) => ({ bears: state.bears, fishes: state.fishes }))
)
```

### Issue #4: Slices pattern TypeScript complexity

**Error:** `StateCreator` types fail to infer when combining slices.

**Why:** Each slice needs explicit `StateCreator` annotations so the combined store type resolves.

```ts
import { create, StateCreator } from "zustand"

interface BearSlice { bears: number; addBear: () => void }
interface FishSlice { fishes: number; addFish: () => void }

const createBearSlice: StateCreator<
  BearSlice & FishSlice,  // combined store type
  [],                     // middleware mutators (empty if none)
  [],                     // chained middleware
  BearSlice               // this slice's type
> = (set) => ({
  bears: 0,
  addBear: () => set((state) => ({ bears: state.bears + 1 })),
})

const createFishSlice: StateCreator<
  BearSlice & FishSlice,
  [],
  [],
  FishSlice
> = (set) => ({
  fishes: 0,
  addFish: () => set((state) => ({ fishes: state.fishes + 1 })),
})

const useStore = create<BearSlice & FishSlice>()((...a) => ({
  ...createBearSlice(...a),
  ...createFishSlice(...a),
}))
```

## Middleware

**Persist (UI preferences only):**

```ts
import { persist, createJSONStorage } from "zustand/middleware"

const useUiPrefs = create<UiPrefs>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      lastTab: "overview",
      menuOpen: false,
      setLastTab: (lastTab) => set({ lastTab }),
    }),
    {
      name: "ui-prefs",
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed, lastTab: state.lastTab }),
      storage: createJSONStorage(() => localStorage),
    },
  ),
)
```

`partialize` lets you skip transient fields (open/closed flags, drag state) from the saved blob.

**Devtools (Redux DevTools):**

```ts
import { devtools } from "zustand/middleware"

const useStore = create<CounterStore>()(
  devtools(
    (set) => ({
      count: 0,
      increment: () => set((s) => ({ count: s.count + 1 }), undefined, "increment"),
    }),
    { name: "CounterStore" },
  ),
)
```

The third argument to `set` (`"increment"`) becomes the action label in DevTools.

**Combining middlewares (order matters — outer wraps inner):**

```ts
const useStore = create<MyStore>()(
  devtools(
    persist(
      (set) => ({ /* state */ }),
      { name: "storage" },
    ),
    { name: "MyStore" },
  ),
)
```

Conventional order: `devtools(persist(immer(stateCreator)))`.

## Common patterns

**Computed / derived values** — compute in the selector, don't store:

```ts
const itemCount = useStore((state) => state.items.length)
const completedCount = useStore((state) => state.items.filter((i) => i.done).length)
```

**Async actions:**

```ts
const useDataStore = create<DataStore>()((set) => ({
  data: null,
  isLoading: false,
  fetchData: async () => {
    set({ isLoading: true })
    const res = await fetch("/api/data")
    set({ data: await res.json(), isLoading: false })
  },
}))
```

For anything that hits `/api/...` prefer `data-fetching` (TanStack Query) — Zustand-as-fetcher gives up cache invalidation, retries, request deduplication, and `signal` cancellation.

**Reset to initial state:**

```ts
const initialState = { count: 0, name: "" }

const useStore = create<ResettableStore>()((set) => ({
  ...initialState,
  reset: () => set(initialState),
}))
```

**Selector with params (lookup):**

```ts
const todo = useStore((state) => state.todos.find((t) => t.id === id))
```

If the lookup is expensive and the input is stable, wrap the selector in `useCallback` to keep its reference stable across renders.

## Advanced

**Vanilla store (use outside React):**

```ts
import { createStore } from "zustand/vanilla"

const store = createStore<CounterStore>()((set) => ({
  count: 0,
  increment: () => set((s) => ({ count: s.count + 1 })),
}))

const unsubscribe = store.subscribe((state) => console.log(state.count))
store.getState().increment()
```

Useful for wiring stores to non-React code (workers, listeners, services).

**Custom middleware:**

```ts
const logger: Logger = (f, name) => (set, get, store) => {
  const loggedSet: typeof set = (...args) => {
    set(...args)
    console.log(`[${name}]`, get())
  }
  return f(loggedSet, get, store)
}
```

**Immer middleware** (mutable-style updates for deeply nested state):

```ts
import { immer } from "zustand/middleware/immer"

const useKanbanStore = create<KanbanStore>()(
  immer((set) => ({
    columns: { todo: { items: [] }, doing: { items: [] }, done: { items: [] } },
    moveItem: (itemId, fromCol, toCol) => set((state) => {
      const item = state.columns[fromCol].items.find((i) => i.id === itemId)
      if (!item) return
      state.columns[fromCol].items = state.columns[fromCol].items.filter((i) => i.id !== itemId)
      state.columns[toCol].items.push(item)
    }),
  })),
)
```

`zustand/middleware/immer` needs the `immer` package: `yarn add immer` first. Keep the `()()` pattern: `create<T>()(immer(...))`.

## When to use what

| Need | Use |
|---|---|
| Local to one component | `useState` |
| Frequently changing value (mouse position, scroll) that doesn't need to re-render | `useRef` |
| Shared across 2+ components (UI flags, selections, modals, kanban state) | **Zustand** |
| Server data from `/api` | **`data-fetching`** (TanStack Query) |
| Form state | **react-hook-form** (covered by `ui` skill) |
| Filters / pagination that should live in the URL | `useSearchParams` from react-router |
| Cross-tab synchronization of persisted state | Zustand `persist` + a storage event listener |

## Common mistakes

- **Destructuring the whole store** — `const { x, y } = useStore()` re-renders on **any** store change (distinct from the new-object-in-selector trap in Issue #3, which infinite-loops). Use `useStore((s) => s.x)` per value, or `useShallow` for a multi-value object.

For the `()()` currying trap see Issue #1, infinite renders Issue #3, and server-data / mutation / persist-name rules in the Critical rules lists above.

## Official documentation

- Zustand docs: https://zustand.docs.pmnd.rs/
- TypeScript guide: https://zustand.docs.pmnd.rs/guides/typescript
- GitHub: https://github.com/pmndrs/zustand
