---
kind: explanation
---

# Design system

> Where the shell's colour, type, metrics and motion are authored, and how a component gets at them?

## How it works

### Layers

- `frontend/src/styles/shell.css` is the only place a colour, a font size, a control height or an easing curve is written down; every other stylesheet and component reads a token from it.
- The semantic layer names surfaces (`--bg-app`, `--bg-panel`, `--bg-content`, `--bg-elevated`), ink (`--ink-subtle`, `--ink-default`, `--ink-strong`, `--ink-on-solid`), the brand fill (`--fill-solid`, `--ink-accent`) and the hairlines (`--border-subtle`, `--border-default`).
- Domain tokens (`--env-production`, `--job-failed`, `--diff-added`, `--published`) hold the same value in light and dark, so an environment or a job phase keeps its identity across a mode flip.
- Those domain tokens come in three kinds, kept apart because they answer different questions: **status** (`--job-*`, `--env-*`, `--diff-*`), **identity** (`--kind-doc`, `--kind-sheet`, … — a spreadsheet is green because it is a spreadsheet, not because anything succeeded) and **series** (`--series-1` … `--series-6`, six chart hues whose only job is to stay apart).
- The legacy shadcn names (`--background`, `--primary`, `--muted-foreground`, …) survive as `H S% L%` triplets pointing at the same palette, so every component already written against `bg-background` or `text-muted-foreground` renders in the new look untouched, and the `/ <alpha>` modifier keeps working.
- `frontend/src/index.css` exposes both sets to Tailwind through `@theme inline`; the shell names arrive as utilities (`bg-panel`, `text-ink-subtle`, `border-line`).
- Shell token names stay out of the namespace the embedded chat writes on `:root` (`--text-*`, `--border-base`, `--border-focus`, `--surface-*`, `--icon-*`, …): the ink ramp is `--ink-*` and the border ink and accent are `--border-ink` and `--border-accent`, so a chat palette can never shadow a shell value at equal specificity. The stylesheet opencode appends is removed when the chat unmounts.

### Tones

- A component never names a colour. A **setter** says which hue (`of-tone-needs-you`, `of-tone-done`, `of-series-3`, `of-tone-pdf`) and a **role** says what the hue is doing: `of-tone` (tinted chip), `of-ink` (text), `of-dot`, `of-note` / `of-note-sm` (notice box), `of-wash` (a tint too faint to read as an object), `of-fill` (full strength), `of-hair` (toned border), `of-banner` (a strip with one hairline) and `of-spot` (a momentary highlight). Two classes per element.
- The setter sets `--tone` and nothing else. Everything the roles paint — ink, tint, hairline, dot — is derived from that one hue with `oklch(from …)`, so a scheme flip is four numbers (`--tone-ink-l`, `--tone-ink-c`, `--tone-tint`, `--tone-dot-dl`) and a new tone is a one-line block.
- The derivation moves lightness and holds hue. `color-mix` toward white or black rotates it, because white carries no hue and reads as 0 — it turns blue into teal and violet into pink.
- `--tone` inherits, so a setter on a row feeds the dot, the label and the bar inside it; a nested setter overrides it for one badge.
- The floors are measured against the live stylesheet, both schemes: ink on its own tint reaches APCA |Lc| 62.3–73.8 against a floor of 60, and dots reach 3.6–9.65:1 against the 3:1 that WCAG 1.4.11 asks of a meaningful graphic. The light dot drops `.06` in lightness because mid-tones sit too close to bright surfaces — raw amber measures 2.85:1 — and holds still in dark, where near-black separates them for free.

### Type and fonts

- Size, line height and weight travel together as one composite token (`--text-ui`, `--text-body`, `--text-title`, `--text-display`, `--mono-code`), applied through the `.t-*` utility classes; tracking rides alongside as `--ls-*`.
- Inter and IBM Plex Mono are loaded from the repository — Inter from the vendored opencode UI assets, IBM Plex Mono from the `@ibm/plex` dependency — never from a CDN, so the shell renders in the same two faces as the embedded chat.
- The dev server's `fs.allow` list carries the resolved `@ibm/plex` directory, because Yarn unplugs that package above the package root.

### Metrics and motion

- There are exactly three control heights — `--h-compact` 24px, `--h-default` 32px, `--h-primary` 36px — and one row geometry, `.of-row`, shared by the sidebar lists and the command palette; the project cards and the runs dock cards take their padding from the same density tokens (`--card-pad`, `--row-pad`).
- Durations and easings are tokens (`--dur-fast`, `--dur`, `--dur-slow`, `--ease-standard`, `--ease-spring`); `prefers-reduced-motion` and `[data-motion="reduced"]` flatten them in one place.

### Appearance

- The user's choices ride on `<html>`: `data-scheme`, `data-contrast`, `data-density`, the `--font-scale` custom property, and — when a non-default seed is picked — the semantic tokens themselves as inline custom properties; the stylesheet is the only subscriber.
- `frontend/src/lib/appearance.ts` owns the signals and writes them; an inline script in `index.html` applies the stored values before first paint so a dark-mode user never sees a white flash.
- Base and Accent are seeds, not tokens: `frontend/src/lib/theme-seeds.ts` feeds them to the OKLCH generator vendored at `opencode/packages/ui/src/theme/color.ts` and maps its scales onto the semantic layer and onto the legacy bridge, checking accent text against a 4.5:1 floor and choosing the ink on a solid fill by ratio.
- The default seeds write nothing at all — they mean "use the authored stylesheet", whose values were tuned against the APCA floors by hand and which the generator would only approximate.
- Dark is authored rather than inverted: the surface ladder carries about four times the separation of light, and `--fill-solid` brightens to the brand tint and takes dark ink.

## Edge cases

- When `localStorage` is unavailable the boot script does nothing and the stylesheet defaults apply — light, normal contrast, comfortable density.
- When the mode is `system`, the scheme keeps following the OS after boot through a `matchMedia` listener, not only at load.
- When a seed is chosen and then set back to the default, the inline custom properties are removed rather than recomputed, so the authored values return exactly.
- When a role class is used with no setter anywhere above it, `--tone` falls back to `--ink-subtle`, so the element renders neutral rather than transparent.
- A theme swap suppresses transitions for one frame but keeps CSS animations running, so a working indicator does not freeze mid-flip.

## Code

- `frontend/src/styles/shell.css` — the tokens, the tone recipe, the primitives and the shell classes.
- `frontend/src/index.css` — Tailwind entry; maps both token sets into `@theme inline`.
- `frontend/src/lib/appearance.ts` — the mode, contrast, density, font-size and seed signals.
- `frontend/src/lib/theme-seeds.ts` — the seed lists and the mapping from the generator's scales onto the semantic layer.
- `frontend/src/components/project/opencode-shell-theme.ts` — the same palette, handed to the embedded chat.
- `frontend/src/routes/settings/appearance.tsx` and `frontend/index.html` — the page that drives the choices, and the script that applies them before first paint.

## Related

- [OpenCode embed](opencode-embed.md) — the chat surface inside the project page, which carries its own theme.
