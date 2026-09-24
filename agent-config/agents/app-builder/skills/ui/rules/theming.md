# Theming

Tailwind v4 with CSS-first configuration. **No `tailwind.config.js`** — everything lives in `frontend/src/index.css` via `@theme inline`.

## Architecture

Colors are OKLCH CSS variables in `:root` (light) and `.dark` (dark). Tailwind maps them via `@theme inline`.

```css
/* index.css */
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --primary: oklch(0.205 0 0);             /* CSS variable */
}

@theme inline {
  --color-primary: var(--primary);          /* Tailwind picks this up → bg-primary, text-primary */
  --radius-lg: var(--radius);               /* → rounded-lg */
}
```

## Color token reference

**Always use semantic tokens — never `bg-white`, `bg-gray-900`, `text-black`.**

| Token         | Tailwind class                                | Purpose                            |
| ------------- | --------------------------------------------- | ---------------------------------- |
| **Page**      | `bg-background` / `text-foreground`           | Main page background + text        |
| **Cards**     | `bg-card` / `text-card-foreground`            | Card / panel surfaces              |
| **Popover**   | `bg-popover` / `text-popover-foreground`      | Dropdown menus, popovers           |
| **Primary**   | `bg-primary` / `text-primary-foreground`      | Primary buttons, CTAs              |
| **Secondary** | `bg-secondary` / `text-secondary-foreground`  | Secondary buttons                  |
| **Muted**     | `bg-muted` / `text-muted-foreground`          | Disabled elements, hints           |
| **Accent**    | `bg-accent` / `text-accent-foreground`        | Highlights, hover states           |
| **Destructive** | `bg-destructive` / `text-destructive-foreground` | Delete buttons, errors        |
| **Borders**   | `border-border`                               | General borders                    |
| **Inputs**    | `border-input`                                | Form input borders                 |
| **Focus**     | `ring-ring`                                   | Focus rings                        |
| **Charts**    | `text-chart-1` … `text-chart-5`               | Chart colors (also `fill-`/`stroke-`) |

### Sidebar tokens (apps with sidebar nav)

| Token                   | Class                       | Purpose              |
| ----------------------- | --------------------------- | -------------------- |
| `--sidebar`             | `bg-sidebar`                | Sidebar background   |
| `--sidebar-foreground`  | `text-sidebar-foreground`   | Sidebar text         |
| `--sidebar-primary`     | `bg-sidebar-primary`        | Active sidebar item  |
| `--sidebar-accent`      | `bg-sidebar-accent`         | Hover state          |
| `--sidebar-border`      | `border-sidebar-border`     | Sidebar border       |

## Customizing for a new app's brand

Edit `:root` (and `.dark`) variables in `frontend/src/index.css`:

```css
:root {
  --primary: oklch(0.55 0.2 250);             /* blue brand */
  --primary-foreground: oklch(0.985 0 0);     /* white text on blue */
}
.dark {
  --primary: oklch(0.65 0.22 250);            /* lighter blue for dark mode */
  --primary-foreground: oklch(0.1 0 0);       /* dark text */
}
```

OKLCH format: `oklch(lightness chroma hue)` — lightness 0–1, chroma 0–0.4 (saturation), hue 0–360.

## Border radius

Driven by `--radius` (default `0.625rem`). Sizes are computed:

| Class         | Value                                     |
| ------------- | ----------------------------------------- |
| `rounded-sm`  | `calc(var(--radius) - 4px)` = 0.375rem    |
| `rounded-md`  | `calc(var(--radius) - 2px)` = 0.5rem      |
| `rounded-lg`  | `var(--radius)` = 0.625rem                |
| `rounded-xl`  | `calc(var(--radius) + 4px)` = 0.875rem    |

## Dark mode

Toggle with `next-themes` — the starter does not ship it, so `yarn add next-themes` first:

```tsx
import { useTheme } from "next-themes"
import { Sun, Moon } from "lucide-react"

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <Button variant="ghost" size="icon" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  )
}
```

- Wrap `<App />` with `<ThemeProvider attribute="class">` from `next-themes` once at the root.
- No `dark:` prefixes on semantic tokens — they auto-switch via the CSS variable system. Only use `dark:` for non-token values like `dark:hidden`.
- Set `color-scheme: dark` on `<html>` (or via the provider's `enableSystem`) so native scrollbars/inputs match.
- `<meta name="theme-color">` should match the page background.

**Hydration**: `useTheme()` returns `undefined` during SSR. Either guard with a `mounted` state or read `resolvedTheme` only after `useEffect` fires.

## Animations (`tw-animate-css`)

Composable utility classes pre-installed:

```tsx
<div className="animate-in fade-in duration-300" />                // fade in
<div className="animate-in fade-in slide-in-from-bottom-4" />      // fade + slide up
<div className="animate-in zoom-in-95" />                           // scale in
<div className="animate-out fade-out slide-out-to-top-2" />        // exit
```

Combine `fade-in` + `slide-in-from-*` + `zoom-in-*` with `duration-*` and `delay-*`. Directions: `slide-in-from-{top|bottom|left|right}` with `-N` suffix for distance.

## Chart colors

In Tailwind classes: `text-chart-1`, `bg-chart-1`, `fill-chart-1`, `stroke-chart-1`. In Recharts / SVG inline:

```tsx
<Bar fill="var(--chart-1)" />
```

## Common mistakes

1. **`bg-white` / `bg-gray-*` / `text-black`** — breaks dark mode. Use semantic tokens.
2. **Adding `tailwind.config.js`** — not needed in v4. Config lives in `index.css` via `@theme inline`.
3. **`useTheme()` without mount guard** — `theme` is `undefined` during hydration; use `resolvedTheme` after `mounted`.
4. **Forgetting `bg-background text-foreground` on the root** — without these on `<body>` or app root, dark mode shows the browser default.
5. **Hover with full opacity** — use `bg-primary hover:bg-primary/90` (opacity modifier) rather than swapping to a different token.
