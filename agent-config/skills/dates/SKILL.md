---
name: dates
description: date-fns v4 with native @date-fns/tz — parsing/formatting, calculations, timezone-safe patterns, calendar pickers (react-day-picker), and common pitfalls. Use whenever working with dates, timestamps, durations, calendar pickers, due dates, schedule windows, time zones, DST, or any timezone-sensitive computation.
---

# date-fns + @date-fns/tz

## Purpose

Use this skill to implement, review, and refactor date/time code with modern `date-fns` and the native timezone package `@date-fns/tz`.

## Version baseline

- Written against `date-fns` major v4 and `@date-fns/tz` major v1. For the primary docs, Read references/version-and-sources.md.

## Non-negotiable rules

- Use the native timezone package `@date-fns/tz`; never `date-fns-tz` (migrate it if you find it in legacy code).
- Parse once, validate early with `isValid`, and pass `Date` values through operations — don't mix string math with date math.
- Use Unicode tokens correctly (`yyyy`, `MM`, `dd`) and avoid Moment-style token assumptions (`YYYY`/`DD` are usually bugs).
- For timezone-sensitive calculations, use explicit timezone context (`TZDate` or `{ in: tz("...") }`).

## Canonical imports

```ts
import { format, parseISO, isValid, addDays, startOfDay } from "date-fns";
import { TZDate, tz, tzOffset, tzName, tzScan } from "@date-fns/tz";
```

Parse with `parseISO`/`toDate`, compute with pure helpers (`add`/`sub`, `differenceIn*`, `startOf*`/`endOf*`, `isSame*`, `isWithinInterval`), and keep transport format (`formatISO`, `formatRFC3339`) separate from display `format`. Avoid mutating `Date` via setters.

## Timezones (@date-fns/tz)

Two patterns — pick by where the zone context belongs:

**Pattern A — `TZDate` as the value.** Use when the date object itself should carry a zone (a domain value tied to a specific location, e.g. a store's local opening time):

```ts
import { TZDate } from "@date-fns/tz";
import { addHours } from "date-fns";

const sg = new TZDate(2026, 2, 1, "Asia/Singapore");
const plus2 = addHours(sg, 2); // stays in Asia/Singapore
```

**Pattern B — `{ in: tz("Area/City") }` context option.** Use when inputs are mixed (e.g. UTC ISO strings) and only the *calculation* needs a deterministic zone:

```ts
import { differenceInBusinessDays } from "date-fns";
import { tz } from "@date-fns/tz";

differenceInBusinessDays("2026-03-10T20:00:00Z", "2026-03-01T20:00:00Z", {
  in: tz("America/New_York"),
});
```

Use IANA zone IDs (`America/New_York`), never fixed offsets, so DST is handled. Near a DST boundary always compute with explicit zone context. `tzOffset`, `tzName`, and `tzScan` (DST transition points) are available for offset/name/transition queries — Read references/native-timezones.md when you need them.

## Calendar picker (react-day-picker)

`react-day-picker` is preinstalled. **Import its stylesheet once at app entry** (e.g. `main.tsx`) or the calendar renders unstyled:

```ts
import "react-day-picker/style.css"
```

**Single date** — pair with the `Popover` + `Button` from the `ui` skill for a date-input field:

```tsx
import { useState } from "react"
import { DayPicker } from "react-day-picker"
import { format } from "date-fns"
import { Calendar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

function DatePickerField({ value, onChange }: {
  value?: Date
  onChange: (date?: Date) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full justify-start text-left", !value && "text-muted-foreground")}
        >
          <Calendar className="h-4 w-4 mr-2" />
          {value ? format(value, "PP") : "Pick a date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <DayPicker
          mode="single"
          selected={value}
          onSelect={(d) => { onChange(d); setOpen(false) }}
        />
      </PopoverContent>
    </Popover>
  )
}
```

**Date range:**

```tsx
import { DayPicker, type DateRange } from "react-day-picker"
import { differenceInDays } from "date-fns"

const [range, setRange] = useState<DateRange>()

<DayPicker mode="range" selected={range} onSelect={setRange} numberOfMonths={2} />

if (range?.from && range?.to) {
  const days = differenceInDays(range.to, range.from)
}
```

When you need a **constrained picker** (disable past/weekends, cap the month range) or **react-hook-form integration** (store dates as ISO strings), Read references/picker.md.

## Further references

Read only when the situation calls for it:

- When you need the full helper catalogue, Read references/core-functions.md.
- When formatting/parsing with tokens, Read references/format-parse-tokens.md for token correctness.
- When wiring imports or checking runtime practices, Read references/imports-and-practices.md.
- When you want copy-ready snippets, Read references/examples.md.
- When migrating away from `date-fns-tz` or auditing pitfalls, Read references/anti-patterns.md.
