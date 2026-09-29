#!/usr/bin/env node
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const gateDir = path.resolve(here, "..", "..", "backend", "src", "store", "gate")
const outPath = path.resolve(here, "..", "agents", "skill-agent-builder", "template", "scripts", "validate-skill.mjs")

const GATE_SOURCES = ["skill-tree.ts", "frontmatter.ts", "flags.ts", "validate.ts"]

const IMPORT_STATEMENT = /^import\b[\s\S]*?;$/gm
const EXPORT_KEYWORD = /^export (?=(?:const|function|class|async) )/gm

function toModuleBody(typescript) {
  return stripTypeScriptTypes(typescript, { mode: "strip" })
    .replaceAll(IMPORT_STATEMENT, "")
    .replaceAll(EXPORT_KEYWORD, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim()
}

function sourceHash(contents) {
  return createHash("sha256").update(contents).digest("hex")
}

async function readGateSources() {
  const sources = []
  for (const name of GATE_SOURCES) {
    const contents = await readFile(path.join(gateDir, name), "utf8")
    sources.push({ name, contents, hash: sourceHash(contents) })
  }
  return sources
}

const HEADER = `/**
 * GENERATED FILE — do not edit.
 *
 * The offline copy of the platform's skill validation gate, so the authoring loop sees the same
 * ERRORS and LINTS the API would answer without spending a round trip. Regenerate with:
 *
 *   node agent-config/scripts/generate-validate-skill.mjs
 *
 * Sources, with the sha256 the copy was cut from (the drift test recomputes these):
`

const RUNNER = `

function walk(directory, prefix) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const relative = prefix ? \`\${prefix}/\${entry.name}\` : entry.name
    if (entry.isSymbolicLink()) {
      found.push({ path: relative, content: Buffer.alloc(0), executable: false, symlink: true })
      continue
    }
    if (entry.isDirectory()) {
      found.push(...walk(absolute, relative))
      continue
    }
    found.push({
      path: relative,
      content: readFileSync(absolute),
      executable: (lstatSync(absolute).mode & 0o111) !== 0,
    })
  }
  return found
}

function readSkillDirectory(directory) {
  return walk(directory, "").toSorted((a, b) => a.path.localeCompare(b.path))
}

function render(findings) {
  return findings
    .map((finding) => {
      const where = finding.file ? \`\${finding.file}\${finding.line ? \`:\${finding.line}\` : ""}: \` : ""
      return \`  [\${finding.rule}] \${where}\${finding.message}\`
    })
    .join("\\n")
}

function main(argv) {
  const args = argv.slice(2)
  const json = args.includes("--json")
  const nameIndex = args.indexOf("--name")
  const expectedName = nameIndex === -1 ? undefined : args[nameIndex + 1]
  const directory = args.find((arg) => !arg.startsWith("--") && arg !== expectedName)
  if (!directory) {
    console.error("usage: validate-skill.mjs <skill-directory> [--name <skill-name>] [--json]")
    return 2
  }

  const tree = readSkillDirectory(directory)
  const result = validateSkillTree(tree, expectedName ? { expectedName } : {})
  const report = {
    valid: result.errors.length === 0,
    errors: result.errors,
    lints: result.lints,
    flags: { hasExecutables: result.flags.has_executables },
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return report.valid ? 0 : 1
  }

  if (result.errors.length > 0) {
    console.log(\`ERRORS (\${result.errors.length}) — the API refuses a write while any of these stand:\`)
    console.log(render(result.errors))
  } else {
    console.log("ERRORS (0) — the gate would accept this tree.")
  }
  if (result.lints.length > 0) {
    console.log(\`\\nLINTS (\${result.lints.length}) — advice; they never block a write:\`)
    console.log(render(result.lints))
  }
  console.log(\`\\nflags: has_executables=\${result.flags.has_executables}\`)
  return report.valid ? 0 : 1
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  process.exit(main(process.argv))
}
`

function renderValidator(sources) {
  const header = [
    HEADER,
    ...sources.map((source) => ` *   backend/src/store/gate/${source.name}  ${source.hash}\n`),
    " */\n\n",
    'import { lstatSync, readFileSync, readdirSync } from "node:fs"\n',
    'import { join } from "node:path"\n',
  ].join("")
  const body = sources.map((source) => toModuleBody(source.contents)).join("\n\n")
  return `${header}\n${body}\n${RUNNER}`
}

async function main() {
  const argv = process.argv.slice(2)
  const outIndex = argv.indexOf("--out")
  const target = outIndex === -1 ? outPath : argv[outIndex + 1]
  if (!target) {
    console.error("usage: generate-validate-skill.mjs [--out <path>]")
    process.exit(2)
  }
  const sources = await readGateSources()
  await writeFile(target, renderValidator(sources))
  console.log(`wrote ${target} from ${sources.length} gate source(s)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
