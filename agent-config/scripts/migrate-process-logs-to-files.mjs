#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const USAGE = `migrate-process-logs-to-files — move a workspace's process logs out of data/database.db into data/logs/.

  node migrate-process-logs-to-files.mjs [--apply] [--retention-hours 72] [--platform-skill <SKILL.md>] (--scan <root> | <workspace>...)

  <workspace>               a ProjectEnvironment directory (the one mounted as /workspace)
  --scan <root>             every directory under <root> holding data/ or .opencode/, four levels deep at most
  --apply                   write the files, drop the tables and refresh the platform skill; without it nothing changes
  --retention-hours N       copy only rows newer than N hours (default 72, what the log files keep)
  --platform-skill <path>   the current platform SKILL.md, written over a workspace copy that still names the old tables

Run it only once no agent pod runs an image older than 0.38.0: an old log-writer still writes the tables.
A database SQLite reports as corrupt is moved aside to database.db.corrupt-<stamp>; the proxy starts a fresh one.

Prints one JSON line per workspace.`

const PROCESS_TABLES = ["process_logs", "process_events"]
const OLD_TABLE_PATTERN = /process_logs|process_events/
const PLATFORM_SKILL_PATH = path.join(".opencode", "skills", "platform", "SKILL.md")
const CORRUPTION = /malformed|not a database|corrupt/i
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".xdg", ".cache", "data", "dist", "build", ".next"])

export function logFileName(processName) {
  const name = String(processName ?? "").replace(/[^A-Za-z0-9._-]/g, "_")
  return `${name.replace(/^\.+|\.+$/g, "") === "" ? "unknown" : name}.log`
}

export function isoTimestamp(sqliteDatetime) {
  return `${String(sqliteDatetime).replace(" ", "T").slice(0, 19)}.000Z`
}

export function eventText(row) {
  const fields = [
    ["exit_code", row.exit_code],
    ["uptime_seconds", row.uptime_seconds],
    ["restart_count", row.restart_count],
  ]
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  return ["[event]", row.event, ...fields].join(" ")
}

function existingTables(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  return PROCESS_TABLES.filter((table) => names.includes(table))
}

function readRows(db, tables, retentionHours) {
  const since = `-${retentionHours} hours`
  const rows = []
  if (tables.includes("process_logs")) {
    for (const row of db
      .prepare("SELECT id, process_name, line, created_at FROM process_logs WHERE created_at >= datetime('now', ?)")
      .all(since)) {
      rows.push({ name: row.process_name, at: row.created_at, order: 1, id: row.id, text: row.line })
    }
  }
  if (tables.includes("process_events")) {
    for (const row of db
      .prepare(
        "SELECT id, process_name, event, exit_code, uptime_seconds, restart_count, created_at FROM process_events WHERE created_at >= datetime('now', ?)",
      )
      .all(since)) {
      rows.push({ name: row.process_name, at: row.created_at, order: 0, id: row.id, text: eventText(row) })
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id))
}

function olderRowCount(db, tables, retentionHours) {
  return tables.reduce(
    (total, table) =>
      total + db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE created_at < datetime('now', ?)`).get(`-${retentionHours} hours`).count,
    0,
  )
}

function checkIntegrity(db) {
  const { quick_check: result } = db.prepare("PRAGMA quick_check").get()
  if (result !== "ok") throw new Error(`database disk image is malformed: ${result}`)
}

function quarantine(databasePath, stamp) {
  const moved = `${databasePath}.corrupt-${stamp}`
  renameSync(databasePath, moved)
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    if (existsSync(databasePath + suffix)) renameSync(databasePath + suffix, moved + suffix)
  }
  return path.basename(moved)
}

function groupByFile(rows) {
  const files = new Map()
  for (const row of rows) {
    const file = logFileName(row.name)
    if (!files.has(file)) files.set(file, [])
    files.get(file).push(row)
  }
  return files
}

function stageImported(logsDir, file, rows, stamp) {
  const target = path.join(logsDir, `${file}.imported-${stamp}`)
  const staged = `${target}.tmp`
  writeFileSync(staged, rows.map((row) => `${isoTimestamp(row.at)} ${String(row.text).replace(/\r?\n/g, " ")}\n`).join(""))
  return { staged, target, lastWrite: new Date(isoTimestamp(rows[rows.length - 1].at)) }
}

function publishImported({ staged, target, lastWrite }) {
  renameSync(staged, target)
  utimesSync(target, lastWrite, lastWrite)
}

function inWriteTransaction(db, work) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = work()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

function importStamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z")
}

function filesNamingOldTables(workspace) {
  const found = []
  const visit = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 6 && !SKIPPED_DIRECTORIES.has(entry.name)) visit(full, depth + 1)
        continue
      }
      if (!/\.(md|mdx|sh|js|mjs|cjs|ts|tsx|py)$/.test(entry.name)) continue
      try {
        if (statSync(full).size > 1024 * 1024) continue
        const relative = path.relative(workspace, full)
        if (relative !== PLATFORM_SKILL_PATH && OLD_TABLE_PATTERN.test(readFileSync(full, "utf8"))) found.push(relative)
      } catch {
        continue
      }
    }
  }
  visit(workspace, 0)
  return found
}

function refreshPlatformSkill(workspace, platformSkill, apply) {
  const target = path.join(workspace, PLATFORM_SKILL_PATH)
  if (!platformSkill || !existsSync(target)) return "absent"
  if (!OLD_TABLE_PATTERN.test(readFileSync(target, "utf8"))) return "current"
  if (apply) writeFileSync(target, platformSkill)
  return apply ? "replaced" : "would-replace"
}

export function migrateWorkspace(
  workspace,
  { apply = false, retentionHours = 72, platformSkill = null, now = new Date() } = {},
) {
  const report = { workspace, status: "no-database" }
  const databasePath = path.join(workspace, "data", "database.db")
  const stamp = importStamp(now)

  if (existsSync(databasePath)) {
    try {
      Object.assign(report, migrateDatabase(workspace, databasePath, { apply, retentionHours, stamp }))
    } catch (error) {
      if (!CORRUPTION.test(error.message)) throw error
      report.status = apply ? "quarantined" : "would-quarantine"
      report.error = error.message
      if (apply) report.movedTo = `data/${quarantine(databasePath, stamp)}`
    }
  }

  report.platformSkill = refreshPlatformSkill(workspace, platformSkill, apply)
  report.needsReview = filesNamingOldTables(workspace)
  return report
}

function migrateDatabase(workspace, databasePath, { apply, retentionHours, stamp }) {
  const db = new DatabaseSync(databasePath, { timeout: 5000 })
  try {
    checkIntegrity(db)
    const tables = existingTables(db)
    if (tables.length === 0) return { status: "already-migrated" }

    const staged = []
    let summary
    const migrate = () => {
      const files = groupByFile(readRows(db, tables, retentionHours))
      summary = {
        tables,
        rows: [...files.values()].reduce((total, rows) => total + rows.length, 0),
        droppedOlderRows: olderRowCount(db, tables, retentionHours),
        files: [...files.keys()].map((file) => `data/logs/${file}.imported-${stamp}`),
      }
      if (!apply) return
      const logsDir = path.join(workspace, "data", "logs")
      mkdirSync(logsDir, { recursive: true })
      for (const [file, rows] of files) staged.push(stageImported(logsDir, file, rows, stamp))
      for (const table of tables) db.exec(`DROP TABLE IF EXISTS ${table}`)
    }

    if (!apply) {
      migrate()
      return { status: "would-migrate", ...summary }
    }
    try {
      inWriteTransaction(db, migrate)
    } catch (error) {
      for (const file of staged) rmSync(file.staged, { force: true })
      throw error
    }
    for (const file of staged) publishImported(file)
    db.exec("VACUUM")
    return { status: "migrated", ...summary }
  } finally {
    db.close()
  }
}

export function workspacesUnder(root, depth = 4) {
  const found = []
  const visit = (dir, level) => {
    if (existsSync(path.join(dir, "data")) || existsSync(path.join(dir, ".opencode"))) {
      found.push(dir)
      return
    }
    if (level >= depth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        visit(path.join(dir, entry.name), level + 1)
      }
    }
  }
  visit(root, 0)
  return found
}

function parseArgs(argv) {
  const options = { apply: false, retentionHours: 72, platformSkill: null, scan: null, workspaces: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--apply") options.apply = true
    else if (arg === "--retention-hours") options.retentionHours = Number(argv[++index])
    else if (arg === "--platform-skill") options.platformSkill = readFileSync(argv[++index], "utf8")
    else if (arg === "--scan") options.scan = argv[++index]
    else if (arg === "-h" || arg === "--help") options.help = true
    else options.workspaces.push(path.resolve(arg))
  }
  if (!Number.isFinite(options.retentionHours) || options.retentionHours <= 0) {
    throw new Error("--retention-hours takes a positive number")
  }
  if (options.platformSkill !== null && OLD_TABLE_PATTERN.test(options.platformSkill)) {
    throw new Error("--platform-skill still names process_logs/process_events; pass the current platform SKILL.md")
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help || (!options.scan && options.workspaces.length === 0)) {
    console.log(USAGE)
    process.exit(options.help ? 0 : 2)
  }
  const workspaces = [...options.workspaces, ...(options.scan ? workspacesUnder(path.resolve(options.scan)) : [])]
  let failed = 0
  for (const workspace of workspaces) {
    try {
      console.log(JSON.stringify(migrateWorkspace(workspace, options)))
    } catch (error) {
      failed++
      console.log(JSON.stringify({ workspace, status: "failed", error: error.message }))
    }
  }
  process.exit(failed > 0 ? 1 : 0)
}
