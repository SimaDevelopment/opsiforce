# Read queries go through createAppQuery, not the stock TanStack adapter

The stock `@tanstack/solid-query` adapter backs every query's `data` with a Solid resource, and TanStack Router wraps every route match in a Suspense boundary, so any background refetch briefly re-suspends the route and Solid detaches and re-attaches the route subtree's DOM, which reloads the App preview iframe and resets the embedded chat's scroll. Every read query therefore goes through `createAppQuery`, a wrapper over the same `QueryObserver` engine that stores results in a plain Solid store, reconciled by `id`, so a refetch updates fields in place and never touches a Suspense boundary. Mutations, the client and the devtools stay stock; only the read path is replaced.

## Considered options

- **Stock `createQuery` with local Suspense boundaries.** Rejected: the router's per-route boundary is unconditional, and containing every query is whack-a-mole.
- **Upgrade to `@tanstack/solid-query` v6**, which reads plain state. Rejected for now: it requires Solid 2.0, which the app, the vendored OpenCode UI and Kobalte cannot adopt yet. The wrapper is a back-port and is deleted when that move happens.

## Consequences

- Errors surface on `.error` and `.isError` rather than being thrown into the router's error boundary.
- Lists keep row identity across refetches, so per-row local state survives; primitives and arrays of primitives are replaced wholesale.
