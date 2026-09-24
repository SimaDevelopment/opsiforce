# Routing & URL state

How a user moves through a multi-page app and how that movement is reflected in the URL: React Router v7 routing, breadcrumbs, and list pages whose search / filter / sort / pagination live in the URL. The visual **app shell** (sidebar + mobile hamburger) lives in [patterns.md](patterns.md) → "Responsive App Shell".

All Radix primitives below are pre-installed.

## Routing (React Router v7)

### Setup in App.tsx

```tsx
import { BrowserRouter, Routes, Route, Link, NavLink, useNavigate, useParams, useSearchParams, Outlet } from "react-router-dom"

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

### Layout route (shared nav + content area)

```tsx
function Layout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-50 border-b bg-background px-6 py-3 flex items-center gap-4">
        <NavLink to="/" className={({ isActive }) => cn("text-sm font-medium", isActive ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
          Home
        </NavLink>
        <NavLink to="/tasks" className={({ isActive }) => cn("text-sm font-medium", isActive ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
          Tasks
        </NavLink>
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
```

**Key:** `<Outlet />` renders the matched child route. This is how you share a navbar/sidebar across all pages.

> For a **sidebar** app, use the **Responsive App Shell** ([patterns.md](patterns.md) → "Responsive App Shell") as the `element` of the layout route instead of this top-nav `Layout` — it already carries the mobile hamburger drawer.

### URL params

```tsx
function TaskDetail() {
  const { id } = useParams()
  const { data } = useQuery({
    queryKey: ["tasks", id],
    queryFn: () => fetch(`/api/tasks/${id}`).then(r => r.json()),
    enabled: !!id,
  })
}
```

### Search params (filters, pagination in URL)

```tsx
function TaskList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get("status") ?? "all"
  const page = Number(searchParams.get("page") ?? "1")

  const { data } = useQuery({
    queryKey: ["tasks", { status, page }],
    queryFn: () => fetch(`/api/tasks?status=${status}&page=${page}`).then(r => r.json()),
  })

  function setFilter(newStatus: string) {
    setSearchParams({ status: newStatus, page: "1" })
  }

  function setPage(newPage: number) {
    setSearchParams(prev => {
      prev.set("page", String(newPage))
      return prev
    })
  }
}
```

### Navigate programmatically

```tsx
const navigate = useNavigate()
navigate("/tasks/123")
navigate(-1)                          // go back
navigate("/tasks", { replace: true }) // replace history entry
```

### 404 catch-all

```tsx
function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <h1 className="text-4xl font-bold mb-2">404</h1>
      <p className="text-muted-foreground mb-4">Page not found</p>
      <Button asChild><Link to="/">Go home</Link></Button>
    </div>
  )
}
```

Place `<Route path="*" element={<NotFound />} />` as the **last route** inside the layout.

### Nested routes (e.g., settings sub-pages)

```tsx
<Route path="/settings" element={<SettingsLayout />}>
  <Route index element={<GeneralSettings />} />
  <Route path="profile" element={<ProfileSettings />} />
  <Route path="notifications" element={<NotificationSettings />} />
</Route>
```

`<Route index>` matches the parent path exactly (`/settings`).

## Breadcrumbs

```tsx
import { useLocation, Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"

function Breadcrumbs() {
  const location = useLocation()
  const segments = location.pathname.split("/").filter(Boolean)

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground mb-4">
      <Link to="/" className="hover:text-foreground">Home</Link>
      {segments.map((segment, i) => {
        const path = `/${segments.slice(0, i + 1).join("/")}`
        const isLast = i === segments.length - 1
        const label = segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, " ")
        return (
          <span key={path} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            {isLast ? (
              <span className="text-foreground font-medium">{label}</span>
            ) : (
              <Link to={path} className="hover:text-foreground">{label}</Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
```

## In-page tabs

For tabbed sections within a page, use the `Tabs` component — see [patterns.md](patterns.md) → "Tabs". Radix manages the active tab internally (style with `data-[state=active]:`); no `useState` needed.

## URL-synced search, filter, sort, pagination

Combines a search input + dropdown filters + sort + pagination, all reflected in URL params so filters survive refresh and can be shared as links.

### Filter bar component

```tsx
import { useSearchParams } from "react-router-dom"
import { Search, X, SlidersHorizontal } from "lucide-react"

function FilterBar({ statuses, categories }: { statuses: string[]; categories: string[] }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const status = searchParams.get("status") ?? "all"
  const category = searchParams.get("category") ?? "all"
  const sortBy = searchParams.get("sort") ?? "newest"

  function setFilter(key: string, value: string) {
    setSearchParams(prev => {
      if (value === "all" || value === "") prev.delete(key)
      else prev.set(key, value)
      prev.delete("page")
      return prev
    })
  }

  function clearAll() {
    setSearchParams({})
  }

  const hasFilters = q || status !== "all" || category !== "all"

  return (
    <div className="flex flex-wrap items-center gap-3 mb-6">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setFilter("q", e.target.value)}
          placeholder="Search..."
          className="pl-9"
        />
      </div>
      <select value={status} onChange={(e) => setFilter("status", e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
        <option value="all">All statuses</option>
        {statuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <select value={category} onChange={(e) => setFilter("category", e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
        <option value="all">All categories</option>
        {categories.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      <select value={sortBy} onChange={(e) => setFilter("sort", e.target.value)} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name A-Z</option>
      </select>
      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X data-icon="inline-start" /> Clear
        </Button>
      )}
    </div>
  )
}
```

### Fetching filtered data with TanStack Query

```tsx
function ItemList() {
  const [searchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const status = searchParams.get("status") ?? ""
  const category = searchParams.get("category") ?? ""
  const sort = searchParams.get("sort") ?? "newest"
  const page = Number(searchParams.get("page") ?? "1")

  const { data, isPending } = useQuery({
    queryKey: ["items", { q, status, category, sort, page }],
    queryFn: () => {
      const params = new URLSearchParams()
      if (q) params.set("q", q)
      if (status) params.set("status", status)
      if (category) params.set("category", category)
      params.set("sort", sort)
      params.set("page", String(page))
      params.set("limit", "20")
      return fetch(`/api/items?${params}`).then(r => r.json())
    },
  })
}
```

### Pagination controls

```tsx
function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  )
}

// Wire to URL params
const [searchParams, setSearchParams] = useSearchParams()
<Pagination page={page} totalPages={data.totalPages} onPageChange={(p) => setSearchParams(prev => { prev.set("page", String(p)); return prev })} />
```

### Debounced search (prevent API calls on every keystroke)

```tsx
const [localQuery, setLocalQuery] = useState(q)

useEffect(() => {
  const timer = setTimeout(() => setFilter("q", localQuery), 300)
  return () => clearTimeout(timer)
}, [localQuery])

<Input value={localQuery} onChange={(e) => setLocalQuery(e.target.value)} />
```

The backend reads these query params and returns the filtered, sorted, paginated page — see the `sqlite` and `nestjs-api` skills for the server side.

## Common mistakes

**Routing**
1. **Forgetting `<Outlet />`** in layout components — child routes won't render.
2. **Using `<a href>` instead of `<Link to>`** — causes full page reload, loses app state.
3. **Not guarding `useParams()` with `enabled: !!id`** — `useParams` returns `string | undefined`; unguarded queries fire with `undefined`.
4. **Desktop-only sidebar (no mobile nav)** — a sidebar hidden on mobile with no hamburger leaves mobile users with no navigation at all. Use the Responsive App Shell ([patterns.md](patterns.md)); verify at 375px.

**URL-synced filters**
5. **Not resetting page when filters change** — changing a filter should reset to page 1, or users see empty pages.
6. **Filter state held in `useState` instead of URL** — use `useSearchParams` so filters survive refresh and are shareable.
7. **Filtering large datasets client-side** — for 100+ items, filter on the backend. Client-side filtering is OK for under 100 items.
