---
kind: explanation
adrs: [0043]
---

# Query Adapter

> How do platform read queries refetch without detaching the route DOM, and what does the `createAppQuery` wrapper change?

## How it works

- Every read query uses `createAppQuery` from `frontend/src/lib/create-app-query.ts` instead of the stock `createQuery`, with the same options-thunk signature plus an optional `reconcile` field ([ADR-0043](../adr/0043-read-queries-go-through-createappquery-not-the-stock-tanstack-adapter.md)).
- The wrapper builds on the same `QueryObserver` engine as the official adapters, keeping caching, deduplication, invalidation and refetch, but stores results in a plain Solid store; reading `data` never subscribes to a Suspense boundary, so a refetch updates fields in place and the route DOM, including the App preview iframe and the embedded chat, is never detached ([OpenCode Embed](opencode-embed.md)).
- Results are reconciled into the store by default, keyed by `id`, so object fields and list-item identities stay stable across refetches and a `<For>` keeps its rows and their local state.
- Primitives and arrays of primitives cannot be keyed and are replaced wholesale; a query can pass `reconcile: "<field>"` to key by another field or `reconcile: false` to replace on every settle.
- Errors surface on `.error` and `.isError`; nothing is thrown into the router's error boundary.
- Mutations, the query client, the provider and the devtools stay stock from `@tanstack/solid-query`.
- Global query defaults live in the root route: `staleTime: 0` and `refetchOnWindowFocus: true`.

## Code

- `frontend/src/lib/create-app-query.ts` — the wrapper and its reconcile semantics.
- `frontend/src/routes/__root.tsx` — the global query defaults.

## Related

- [OpenCode Embed](opencode-embed.md) — the two stateful surfaces a DOM detach would break.
