---
name: frontend-design
description: Design polished, visually distinctive frontend UIs that avoid generic "AI template" aesthetics. Use when starting a new app to establish visual identity, or when the UI needs to look more professional, creative, or distinctive. Load this skill at the beginning of every new app.
---

# Frontend Design — Building Distinctive Apps

Every app must have its own visual identity. Avoid the generic "AI-built" look: gray backgrounds, default fonts, symmetrical card grids, purple gradients on white. Be intentional and bold.

## Phase 1: Creative Direction (before writing any code)

Before touching CSS or components, decide:

1. **Purpose** — What does this app do? Who uses it?
2. **Tone** — Pick a direction and commit:
   - Brutally minimal (lots of whitespace, monochrome, sharp edges)
   - Warm & organic (rounded shapes, earthy tones, soft shadows)
   - Bold & playful (bright accents, large type, bouncy motion)
   - Editorial / magazine (dramatic typography, asymmetric layout, strong imagery)
   - Luxury / refined (dark backgrounds, gold/silver accents, thin fonts)
   - Industrial / utilitarian (dense data, monospace, high-contrast)
   - Soft / pastel (light backgrounds, muted colors, gentle transitions)
3. **Differentiation** — What makes this app visually memorable? Pick at least one standout element.

**Vary your designs.** Don't converge on the same choices every time. A recipe app should look nothing like a finance dashboard.

## Phase 2: Theme Setup

Pick a brand color that fits the tone, then set it in `index.css`. The **`ui` skill owns the theming mechanics** — OKLCH variables, the `@theme inline` setup, the full semantic-token list, border radius, and the dark-mode toggle. This section is only about *which* colors to choose.

### Starter palettes by app type

| App type | Direction | OKLCH primary |
|---|---|---|
| Finance / Analytics | Cool, trustworthy | `oklch(0.55 0.2 235)` — blue |
| Health / Wellness | Calm, natural | `oklch(0.55 0.15 165)` — teal |
| Social / Creative | Vibrant, expressive | `oklch(0.55 0.2 300)` — purple |
| Food / Restaurant | Warm, inviting | `oklch(0.6 0.18 45)` — orange |
| Productivity | Focused, sharp | `oklch(0.5 0.22 260)` — indigo |
| E-commerce | Fresh, actionable | `oklch(0.55 0.17 160)` — emerald |
| Education | Bright, accessible | `oklch(0.65 0.16 85)` — amber |

Don't just pick a primary — also choose `--accent`, `--destructive`, and chart colors. A cohesive palette is 1 dominant color + 1 accent + neutral grays. Make dark mode **intentional**, not a raw inversion: slightly lighter / more saturated primaries, softer backgrounds. (How to wire all of this into `index.css` lives in the `ui` skill's theming rules.)

## Phase 3: Typography Hierarchy

Use consistent, clear hierarchy:

```tsx
<h1 className="text-3xl font-bold tracking-tight">Page Title</h1>
<h2 className="text-xl font-semibold">Section Heading</h2>
<h3 className="text-base font-medium">Card Title</h3>
<p className="text-sm text-muted-foreground">Body / description</p>
<span className="text-xs text-muted-foreground uppercase tracking-wider">Label</span>
```

**Rules:**
- One `text-3xl` heading per page — it's the page's identity
- Body text is `text-sm`, secondary info is `text-muted-foreground`
- Use `tracking-tight` on large headings, `tracking-wider` on small labels
- Pair large bold headings with a lighter subtitle for contrast

## Phase 4: Layout & Spacing

### Page container
```tsx
<div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8">
```

### Section spacing — `flex flex-col gap-6` or `gap-8` between major sections

### Card grid
```tsx
<div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
```

### Consistent padding
- Cards: `p-4` or `p-6`
- List items: `px-4 py-3`
- Page sections: `py-6` or `py-8`

### Don't be afraid of asymmetry
- 2/3 + 1/3 split: `grid-cols-3` → `lg:col-span-2` + `lg:col-span-1`
- Sidebar layouts (always via the responsive App Shell in the `ui` skill), offset hero sections, mixed card sizes add visual interest

## Phase 5: Visual Polish

### Shadows & depth
```tsx
<div className="rounded-xl border bg-card p-6 shadow-sm">                      // standard card
<div className="rounded-xl border bg-card p-6 shadow-sm hover:shadow-md transition-shadow">  // interactive card
<div className="rounded-xl bg-primary text-primary-foreground p-8 shadow-lg">   // hero/CTA card
```

### Transitions on everything interactive
```tsx
className="transition-colors"     // buttons, links
className="transition-shadow"     // cards on hover
className="transition-all"        // multi-property
```

### Colored status badges (not just gray)
```tsx
<span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
  Active
</span>
<span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
  Pending
</span>
```

These fixed light/dark colour pairs are the **one** sanctioned use of raw Tailwind colours — success / warning / info have no semantic token. Always include the `dark:` variant. For numeric metrics and everything else, use semantic tokens / `Badge` variants (see the `ui` skill's styling rules).

### Subtle backgrounds for sections
```tsx
<div className="bg-muted/50 rounded-xl p-6">   // soft section background
<div className="bg-primary/5 rounded-xl p-6">   // tinted section
```

### Gradient accents (use sparingly)
```tsx
<div className="bg-gradient-to-r from-primary/10 via-transparent to-accent/10 p-8 rounded-xl">
```

## Common Layout Patterns

### Dashboard
```tsx
<div className="flex flex-col gap-8">
  <div>
    <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
    <p className="text-muted-foreground mt-1">Overview of your activity</p>
  </div>
  <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
    {/* stat cards with icon + number + trend */}
  </div>
  <div className="grid gap-6 lg:grid-cols-3">
    <Card className="lg:col-span-2">{/* main chart or table */}</Card>
    <Card>{/* sidebar widget */}</Card>
  </div>
</div>
```

### List page with header + actions
```tsx
<div className="flex flex-col gap-6">
  <div className="flex items-center justify-between">
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Projects</h1>
      <p className="text-muted-foreground mt-1">{data.length} total</p>
    </div>
    <Button><Plus data-icon="inline-start" /> New Project</Button>
  </div>
  {/* filter bar, then list/grid */}
</div>
```

### Empty state (friendly, not blank)
```tsx
<div className="flex flex-col items-center justify-center py-16 text-center">
  <div className="rounded-full bg-muted p-4 mb-4">
    <Inbox className="size-8 text-muted-foreground" />
  </div>
  <h3 className="text-lg font-medium mb-1">No projects yet</h3>
  <p className="text-sm text-muted-foreground mb-4 max-w-sm">Get started by creating your first project.</p>
  <Button><Plus data-icon="inline-start" /> Create Project</Button>
</div>
```

## Anti-Patterns — What Makes Apps Look Like "AI Slop"

1. **Default gray everything** — no brand color, no personality. Pick a real color.
2. **Symmetrical card grids** — 4 identical cards in a row with icon + title + description. Break the grid.
3. **No hover/transition states** — flat, lifeless UI. Add `hover:` and `transition-*` to everything interactive.
4. **Wall of text** — no visual hierarchy. Use headings, badges, icons, and muted text to create rhythm.
5. **Giant buttons** — oversized CTAs that dominate. Use `size="sm"` for secondary actions.
6. **No empty states** — blank page when there's no data. Always show a friendly CTA.
7. **Purple gradient on white** — the most clichéd "AI app" look. Be more creative.
8. **Cramped layout** — no breathing room. Use generous `gap-*`.

## Design Checklist

Before finishing any app, verify:

- [ ] Brand color set (not default gray)
- [ ] Dark mode vars customized (not just inverted)
- [ ] Clear typography hierarchy (one large heading per page)
- [ ] Cards have `rounded-xl border shadow-sm`
- [ ] All interactive elements have hover states and transitions
- [ ] Empty states handled with icon + message + CTA
- [ ] Icons used in buttons and navigation (Lucide)
- [ ] Mobile-responsive: grid breakpoints **and** reachable navigation (a sidebar collapses to a hamburger/drawer — see the `ui` skill's App Shell; verify at 375px)
- [ ] Consistent spacing between sections
- [ ] At least one "standout" visual element that makes the app distinctive
