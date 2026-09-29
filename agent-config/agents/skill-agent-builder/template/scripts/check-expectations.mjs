#!/usr/bin/env node
// Checks the expectations file's shape before a report goes out.
//
//   node scripts/check-expectations.mjs [scratch/expectations.md]
//
// Exit 0 with a one-line count, or exit 1 with one `<file>:<line>: <offence>` line per offence.
// The shape, section by section:
//   ## Prompts            one list line per prompt, at least one
//   ## Machine-checkable  - <expectation> — `<command>` → <the answer that passes>
//   ## Judgement          - <expectation>
//   ## Fixes              - R<n> · <expectation> · <template|body|skill> · <the record> · <the change> · <update|reset>
//                         (every fix of one round carries the round's one refresh; `- none` before any)
import { readFileSync } from "node:fs"

const file = process.argv[2] ?? "scratch/expectations.md"
const sections = new Map([
  ["prompts", "## Prompts"],
  ["machine-checkable", "## Machine-checkable"],
  ["judgement", "## Judgement"],
  ["fixes", "## Fixes"],
])
const classes = new Set(["template", "body", "skill"])
const refreshes = new Set(["update", "reset"])

let text
try {
  text = readFileSync(file, "utf8")
} catch {
  console.log(`${file}: missing — write it before the run`)
  process.exit(1)
}

const offences = []
const offend = (line, message) => offences.push(`${file}:${line}: ${message}`)
const items = new Map([...sections.keys()].map((key) => [key, []]))
const seen = new Set()
let current = null

text.split("\n").forEach((raw, index) => {
  const line = index + 1
  const heading = /^##\s+(.+?)\s*$/.exec(raw)
  if (heading) {
    const key = heading[1].toLowerCase()
    current = sections.has(key) ? key : null
    if (current) {
      if (seen.has(current)) offend(line, `a second ${sections.get(current)} section`)
      seen.add(current)
    }
    return
  }
  if (current === null || raw.trim() === "" || /^<!--.*-->$/.test(raw.trim())) return
  const item = /^(?:-|\d+\.)\s+(.*\S)\s*$/.exec(raw)
  if (!item) return offend(line, `one list line per entry under ${sections.get(current)}: "${raw.trim()}"`)
  items.get(current).push({ line, text: item[1] })
})

for (const [key, heading] of sections) if (!seen.has(key)) offend(0, `no ${heading} section`)

if (seen.has("prompts") && items.get("prompts").length === 0) offend(0, "## Prompts lists no prompt")

for (const { line, text: entry } of items.get("machine-checkable")) {
  if (!/`[^`]+`\s*→\s*\S/.test(entry)) offend(line, "a machine-checkable line ends in `<command>` → <the answer that passes>")
}

const roundRefresh = new Map()
const fixes = items.get("fixes")
for (const { line, text: entry } of fixes) {
  if (fixes.length === 1 && entry.toLowerCase() === "none") break
  const fields = entry.split(" · ").map((field) => field.trim())
  if (fields.length !== 6 || fields.some((field) => field === "")) {
    offend(line, `a fix has six fields joined by " · ", this one has ${fields.length}`)
    continue
  }
  const [round, , owner, , , refresh] = fields
  if (!/^R\d+$/.test(round)) offend(line, `the round is R<n>, not "${round}"`)
  if (!classes.has(owner)) offend(line, `whose failure is template, body or skill, not "${owner}"`)
  if (!refreshes.has(refresh)) offend(line, `the refresh is update or reset, not "${refresh}"`)
  else if (roundRefresh.has(round) && roundRefresh.get(round) !== refresh)
    offend(line, `${round} already refreshed by ${roundRefresh.get(round)}: a round has one refresh`)
  else roundRefresh.set(round, refresh)
}

if (offences.length > 0) {
  for (const offence of offences) console.log(offence)
  process.exit(1)
}
const count = (key) => items.get(key).length
console.log(
  `OK: ${count("prompts")} prompts, ${count("machine-checkable")} machine-checkable, ${count("judgement")} judgement, ${roundRefresh.size} fixing rounds`
)
