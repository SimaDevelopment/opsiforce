---
name: data-export
description: Export App data from the browser as CSV or JSON downloads, clipboard copies, or print-friendly views. Use when the user wants a download or export button, to copy data, or a printable page. Word, Excel, PowerPoint and PDF deliverables are `document-generation`.
---

# Data Export — CSV, JSON, Print

No additional packages required. Uses built-in browser APIs.

## CSV export (most common)

```tsx
function exportToCSV(data: Record<string, unknown>[], filename: string) {
  if (data.length === 0) return

  const headers = Object.keys(data[0])
  const csvRows = [
    headers.join(","),
    ...data.map(row =>
      headers.map(h => {
        const val = String(row[h] ?? "")
        return val.includes(",") || val.includes('"') || val.includes("\n")
          ? `"${val.replace(/"/g, '""')}"`
          : val
      }).join(",")
    ),
  ]

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${filename}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// Usage
<Button variant="outline" onClick={() => exportToCSV(data, "tasks-export")}>
  <Download className="h-4 w-4 mr-1" /> Export CSV
</Button>
```

## JSON export

```tsx
function exportToJSON(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `${filename}.json`
  a.click()
  URL.revokeObjectURL(url)
}
```

## Backend CSV endpoint (for large datasets)

Generate CSV on the server for datasets too large to hold in browser memory:

```typescript
// backend controller
@Get("export")
exportCSV(@Res() res: Response) {
  const items = this.itemsService.findAll()
  const headers = ["id", "title", "status", "created_at"]
  const csvRows = [
    headers.join(","),
    ...items.map(item =>
      headers.map(h => {
        const val = String(item[h] ?? "")
        return val.includes(",") || val.includes('"') || val.includes("\n")
          ? `"${val.replace(/"/g, '""')}"`
          : val
      }).join(",")
    ),
  ]

  res.setHeader("Content-Type", "text/csv")
  res.setHeader("Content-Disposition", "attachment; filename=export.csv")
  res.send(csvRows.join("\n"))
}
```

```tsx
// Frontend — download link
<a href="/api/items/export" download className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
  <Download className="h-4 w-4" /> Download CSV
</a>
```

## Print-friendly view

```tsx
function PrintButton() {
  return <Button variant="outline" onClick={() => window.print()}>
    <Printer className="h-4 w-4 mr-1" /> Print
  </Button>
}
```

Add print styles in `index.css`:

```css
@media print {
  nav, button, .no-print { display: none !important; }
  body { background: white !important; }
  * { color: black !important; box-shadow: none !important; }
}
```

## Copy to clipboard

```tsx
async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text)
  toast.success("Copied to clipboard")
}

<Button variant="ghost" size="icon" onClick={() => copyToClipboard(item.id)}>
  <Copy className="h-4 w-4" />
</Button>
```

## Common mistakes

1. **Not escaping CSV values** — commas and quotes in data break CSV format. Always wrap values with commas/quotes/newlines in double-quotes.
2. **Not revoking object URL** — `URL.revokeObjectURL(url)` prevents memory leaks.
3. **Large exports blocking the UI** — for 10k+ rows, generate on the backend and stream the download.
