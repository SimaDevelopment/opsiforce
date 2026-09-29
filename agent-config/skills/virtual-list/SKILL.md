---
name: virtual-list
description: Render large lists efficiently with @tanstack/react-virtual. Use when displaying 100+ items in a list, table, or grid — virtualizes rendering so only visible items are in the DOM.
---

# TanStack Virtual — Virtualized Lists

The starter does not ship it: `yarn add @tanstack/react-virtual` first.

## Virtual list (most common)

```tsx
import { useVirtualizer } from "@tanstack/react-virtual"
import { useRef } from "react"

function VirtualList({ items }: { items: { id: number; title: string }[] }) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,  // estimated row height in px
  })

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto rounded-lg border">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]
          return (
            <div
              key={item.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="flex items-center px-4 border-b hover:bg-muted/50"
            >
              {item.title}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

**Key:** The parent (scroll) div must have a **bounded height** and `overflow: auto` — `h-[600px]`, `h-screen`, or `flex-1 overflow-auto`. The inner div uses absolute positioning.

## Virtual table (combine with react-table)

```tsx
function VirtualDataTable({ data, columns }: { data: Item[]; columns: ColumnDef<Item>[] }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })

  const { rows } = table.getRowModel()
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
  })

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto rounded-lg border">
      <table className="w-full">
        <thead className="sticky top-0 bg-background z-10">
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id} className="border-b">
              {hg.headers.map(h => (
                <th key={h.id} className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          <tr style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <td colSpan={columns.length} style={{ padding: 0, position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]
                return (
                  <tr
                    key={row.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                      display: "flex",
                    }}
                    className="border-b hover:bg-muted/50"
                  >
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id} className="px-4 py-3 text-sm flex-1">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
```

## Virtual grid

```tsx
const virtualizer = useVirtualizer({
  count: Math.ceil(items.length / 3),  // 3 columns
  getScrollElement: () => parentRef.current,
  estimateSize: () => 200,  // row height
})

// In render, for each virtual row, render 3 items:
{virtualizer.getVirtualItems().map((virtualRow) => {
  const startIdx = virtualRow.index * 3
  return (
    <div key={virtualRow.index} style={/* absolute positioning */} className="grid grid-cols-3 gap-4 px-4">
      {[0, 1, 2].map(col => {
        const item = items[startIdx + col]
        if (!item) return <div key={col} />
        return <Card key={item.id}>{item.title}</Card>
      })}
    </div>
  )
})}
```

## When to use

| Item count | Approach |
|---|---|
| < 100 | Regular list (no virtualization needed) |
| 100–1000 | Virtualize for smoother scroll |
| 1000+ | **Must** virtualize — DOM will lag otherwise |

## Common mistakes

1. **Wrong `estimateSize`** — set it close to actual row height. Too small = items overlap; too large = gaps.
2. **Forgetting `position: relative`** on the inner container — absolute-positioned items need a positioned parent.
