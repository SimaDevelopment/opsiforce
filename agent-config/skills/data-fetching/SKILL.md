---
name: data-fetching
description: Data fetching and server state for the frontend with TanStack Query v5 — queries, mutations, query keys, cache invalidation, pagination and error handling — plus calling third-party HTTP APIs from the backend. Use whenever the App makes an API request, calls /api, mutates server state, or talks to an external API.
---

# Data Fetching

**v5 changes from v4:** `isLoading` → `isPending`, `cacheTime` → `gcTime`, `keepPreviousData` is now `placeholderData: keepPreviousData`, callbacks (`onSuccess`/`onError`) removed from `useQuery` (still on `useMutation`).

## When to use what

| Need | Use |
|---|---|
| Read data in a React component | `useQuery` |
| Read many items in parallel (dynamic count) | `useQueries` |
| Paginated/infinite list | `useInfiniteQuery` |
| Create / update / delete from a component | `useMutation` |
| File upload | the `react-dropzone` skill (base64 JSON body — the backend has no multipart parser) |
| Call an external API (with API key) | `fetch`/`axios` from a NestJS service — never the frontend |

## useQuery

```tsx
import { useQuery } from "@tanstack/react-query"

const { data, isPending, error } = useQuery({
  queryKey: ["items"],
  queryFn: ({ signal }) => fetch("/api/items", { signal }).then(r => r.json()),
})

// With params (queryKey MUST include every variable queryFn uses)
const { data } = useQuery({
  queryKey: ["items", id],
  queryFn: ({ signal }) => fetch(`/api/items/${id}`, { signal }).then(r => r.json()),
  enabled: !!id,
})
```

Always pass `signal` to `fetch`/`axios` — TanStack cancels in-flight requests when the key changes or the component unmounts. Without it, fast typing in a search box wastes bandwidth and races.

## useMutation

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query"

const queryClient = useQueryClient()

const createItem = useMutation({
  mutationFn: (data: { title: string }) =>
    fetch("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(r => r.json()),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ["items"] }),
})

createItem.mutate({ title: "New item" })
// Loading state: createItem.isPending
```

## Query keys — rules

1. **Always an array** at the top level (not a string, not an object).
2. **Include every variable** the `queryFn` reads. Missing deps cause stale-data bugs and cache collisions across users/filters.
3. **Hierarchical**: `[entity, id, sub-resource, { filters }]`. Lets you invalidate at any level.
4. **JSON-serializable**: no functions, class instances, or `Symbol`s. Use `date.toISOString()` for dates.

```tsx
["items"]                          // list
["items", id]                      // detail
["items", id, "comments"]          // sub-resource
["items", { status: "active" }]    // filtered list
```

## Query key factory (recommended for any app with >5 queries)

Centralize keys so invalidation is type-safe and refactor-proof:

```tsx
// frontend/src/lib/query-keys.ts
export const itemKeys = {
  all: ["items"] as const,
  lists: () => [...itemKeys.all, "list"] as const,
  list: (filters: ItemFilters) => [...itemKeys.lists(), filters] as const,
  details: () => [...itemKeys.all, "detail"] as const,
  detail: (id: number) => [...itemKeys.details(), id] as const,
}

// Usage
useQuery({ queryKey: itemKeys.detail(id), queryFn: () => fetchItem(id) })
queryClient.invalidateQueries({ queryKey: itemKeys.all })       // everything
queryClient.invalidateQueries({ queryKey: itemKeys.detail(5) }) // item 5 + its sub-resources
```

Even better — bundle queryKey + queryFn + options together with `queryOptions`:

```tsx
import { queryOptions } from "@tanstack/react-query"

export const itemQueries = {
  detail: (id: number) => queryOptions({
    queryKey: itemKeys.detail(id),
    queryFn: ({ signal }) => fetch(`/api/items/${id}`, { signal }).then(r => r.json()),
    staleTime: 60 * 1000,
  }),
}

// Usage
const { data } = useQuery(itemQueries.detail(5))
queryClient.prefetchQuery(itemQueries.detail(5))  // shares the same config
```

## Cache invalidation

```tsx
// Prefix match (default): all queries starting with the key
queryClient.invalidateQueries({ queryKey: ["items"] })
// Matches: ["items"], ["items", 1], ["items", { status: "done" }]

// Exact: only the exact key
queryClient.invalidateQueries({ queryKey: ["items"], exact: true })

// Predicate: custom logic
queryClient.invalidateQueries({
  predicate: (q) => q.queryKey[0] === "items" && q.state.data?.userId === currentUserId,
})

// Direct cache write (no refetch)
queryClient.setQueryData(itemKeys.detail(id), newData)
```

After a mutation, **invalidate every query the change affects** — the detail row, the list, any counts, related entities. Use `variables` (the args to `mutate()`) to know which keys to hit:

```tsx
useMutation({
  mutationFn: ({ id, data }) => updateItem(id, data),
  onSuccess: (_data, { id }) => {
    queryClient.invalidateQueries({ queryKey: itemKeys.detail(id) })
    queryClient.invalidateQueries({ queryKey: itemKeys.lists() })
  },
})
```

For optimistic updates, infinite/parallel queries, select transforms, or prefetch-on-hover, Read references/advanced-patterns.md.

## staleTime + gcTime

`staleTime` = how long data is considered fresh (no background refetch on remount). Default `0` = refetch on every mount.
`gcTime` = how long inactive (unobserved) data stays in the cache before being garbage collected. Default 5 min.

| Data type | staleTime |
|---|---|
| Real-time (live feeds) | `0` |
| Frequently changing (notifications) | 30s – 1m |
| User content | 1 – 5m |
| Reference data (categories, config) | 10 – 30m |
| Static | `Infinity` |

Set sensible defaults at the QueryClient level, override per-query:

```tsx
new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } })
```

## Pagination — keep previous data while loading

```tsx
import { keepPreviousData } from "@tanstack/react-query"

const { data, isPlaceholderData } = useQuery({
  queryKey: ["items", page],
  queryFn: () => fetchItems(page),
  placeholderData: keepPreviousData,  // shows page N while page N+1 loads
})
```

Dim the UI with `isPlaceholderData` to signal a refresh is in flight.

## Error handling

`fetch` doesn't throw on 4xx/5xx — wrap it so query/mutation errors flow correctly:

```tsx
async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error(error.message || `HTTP ${res.status}`)
  }
  return res.json()
}

// Usage
useQuery({
  queryKey: itemKeys.all,
  queryFn: ({ signal }) => apiFetch<Item[]>("/api/items", { signal }),
})
```

For retry behavior: TanStack retries 3x by default on query errors. For non-retriable failures (4xx), set `retry: false` or a function that inspects the error.

## Raw HTTP — fetch and axios

For internal `/api/...` calls in components, prefer `useQuery`/`useMutation`. Use raw `fetch` only inside `queryFn`/`mutationFn`, or in backend services.

```tsx
// Built-in fetch
await fetch("/api/items", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "New" }),
})

// Axios — when you want interceptors, baseURL, or timeouts
import axios from "axios"
const api = axios.create({ baseURL: "/api", timeout: 10_000 })
const { data } = await api.get("/items")
await api.post("/items", { title: "New" })
```

Axios supports the same `signal` for cancellation: `api.get("/items", { signal })`.

## Calling external APIs — go through the backend

External API calls must originate from the **backend**, never the frontend. Frontend code is public, so any secret in the bundle is exposed. Read the API key with the `appConfig` helper (`web-app` §App configuration).

```typescript
// backend/src/weather/weather.service.ts
import { appConfig } from "../config"

@Injectable()
export class WeatherService {
  async getWeather(city: string) {
    const res = await fetch(`https://api.example.com/weather?q=${city}&key=${appConfig("WEATHER_KEY")}`)
    if (!res.ok) throw new BadRequestException("Weather API error")
    return res.json()
  }
}
```

The frontend then calls your backend endpoint (`/api/weather?city=...`) with `useQuery` like any other.

## Common mistakes

1. **`staleTime: 0` everywhere** — refetches on every mount, kills perceived performance. Match staleTime to data volatility.
