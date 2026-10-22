import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { logFileName, migrateWorkspace, workspacesUnder } from "./migrate-process-logs-to-files.mjs"

function oldWorkspace() {
  const workspace = mkdtempSync(path.join(tmpdir(), "process-log-migration-"))
  mkdirSync(path.join(workspace, "data"))
  const db = new DatabaseSync(path.join(workspace, "data", "database.db"))
  db.exec(`
    CREATE TABLE process_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, process_name TEXT NOT NULL, line TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE process_events (id INTEGER PRIMARY KEY AUTOINCREMENT, process_name TEXT NOT NULL, event TEXT NOT NULL, exit_code INTEGER, uptime_seconds INTEGER, restart_count INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE app_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO process_logs (process_name, line, created_at) VALUES
      ('app-backend', 'listening on 3000', datetime('now', '-10 minutes')),
      ('app-backend', 'too old to keep', datetime('now', '-5 days')),
      ('my worker', 'tick', datetime('now', '-11 minutes'));
    INSERT INTO process_events (process_name, event, exit_code, uptime_seconds, restart_count, created_at) VALUES
      ('app-backend', 'crashed', 1, 2, 3, datetime('now', '-10 minutes'));
    INSERT INTO app_requests (method, url) VALUES ('GET', '/');
  `)
  db.close()
  mkdirSync(path.join(workspace, ".opencode", "skills", "platform"), { recursive: true })
  writeFileSync(path.join(workspace, ".opencode", "skills", "platform", "SKILL.md"), "SELECT * FROM process_logs\n")
  mkdirSync(path.join(workspace, "app"))
  writeFileSync(path.join(workspace, "app", "NOTES.md"), "check process_events after a deploy\n")
  return workspace
}

const tables = (workspace) => {
  const db = new DatabaseSync(path.join(workspace, "data", "database.db"))
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  db.close()
  return names.map((row) => row.name)
}

test("a dry run reports what it would do and changes nothing", () => {
  const workspace = oldWorkspace()
  try {
    const report = migrateWorkspace(workspace, { platformSkill: "process-logs --since 2m\n" })
    assert.equal(report.status, "would-migrate")
    assert.equal(report.rows, 3)
    assert.equal(report.droppedOlderRows, 1)
    assert.equal(report.platformSkill, "would-replace")
    assert.deepEqual(report.needsReview, [path.join("app", "NOTES.md")])
    assert.deepEqual(tables(workspace), ["app_requests", "process_events", "process_logs"])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("apply copies recent rows into imported log files, drops the tables and keeps the request log", () => {
  const workspace = oldWorkspace()
  try {
    const report = migrateWorkspace(workspace, {
      apply: true,
      platformSkill: "process-logs --since 2m\n",
      now: new Date("2026-10-13T20:00:00Z"),
    })
    assert.equal(report.status, "migrated")
    assert.deepEqual(tables(workspace), ["app_requests"])

    const backend = readFileSync(path.join(workspace, "data", "logs", "app-backend.log.imported-20261013T200000Z"), "utf8").trim().split("\n")
    assert.equal(backend.length, 2)
    assert.match(backend[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z \[event\] crashed exit_code=1 uptime_seconds=2 restart_count=3$/)
    assert.match(backend[1], /Z listening on 3000$/)
    assert.ok(readFileSync(path.join(workspace, "data", "logs", "my_worker.log.imported-20261013T200000Z"), "utf8").includes(" tick"))

    const mtime = statSync(path.join(workspace, "data", "logs", "app-backend.log.imported-20261013T200000Z")).mtimeMs
    assert.ok(Date.now() - mtime > 9 * 60 * 1000, "the imported file is dated by its last row so pruning ages it out")

    assert.equal(report.platformSkill, "replaced")
    assert.equal(readFileSync(path.join(workspace, ".opencode", "skills", "platform", "SKILL.md"), "utf8"), "process-logs --since 2m\n")
    assert.deepEqual(report.needsReview, [path.join("app", "NOTES.md")])

    assert.equal(migrateWorkspace(workspace, { apply: true }).status, "already-migrated")
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("a corrupt database is moved aside so the proxy starts a fresh one", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "process-log-corrupt-"))
  try {
    mkdirSync(path.join(workspace, "data"))
    writeFileSync(path.join(workspace, "data", "database.db"), "this is not a sqlite file at all, just bytes".repeat(200))
    writeFileSync(path.join(workspace, "data", "database.db-journal"), "")

    assert.equal(migrateWorkspace(workspace).status, "would-quarantine")
    assert.ok(existsSync(path.join(workspace, "data", "database.db")))

    const report = migrateWorkspace(workspace, { apply: true, now: new Date("2026-10-14T09:00:00Z") })
    assert.equal(report.status, "quarantined")
    assert.equal(report.movedTo, "data/database.db.corrupt-20261014T090000Z")
    assert.ok(!existsSync(path.join(workspace, "data", "database.db")))
    assert.ok(existsSync(path.join(workspace, "data", "database.db.corrupt-20261014T090000Z-journal")))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("scan finds every workspace, including one whose database was moved aside", () => {
  const root = mkdtempSync(path.join(tmpdir(), "process-log-scan-"))
  try {
    for (const directory of ["projects/a", "projects/b/environments/c"]) {
      mkdirSync(path.join(root, directory, "data"), { recursive: true })
      writeFileSync(path.join(root, directory, "data", "database.db"), "")
    }
    mkdirSync(path.join(root, "projects", "quarantined", "data"), { recursive: true })
    mkdirSync(path.join(root, "projects", "never-started", ".opencode", "skills", "platform"), { recursive: true })
    writeFileSync(path.join(root, "projects", "never-started", ".opencode", "skills", "platform", "SKILL.md"), "SELECT * FROM process_logs\n")
    assert.deepEqual(workspacesUnder(root).map((dir) => path.relative(root, dir)).sort(), [
      "projects/a",
      "projects/b/environments/c",
      "projects/never-started",
      "projects/quarantined",
    ])
    assert.equal(migrateWorkspace(path.join(root, "projects", "quarantined")).status, "no-database")
    const neverStarted = migrateWorkspace(path.join(root, "projects", "never-started"), { apply: true, platformSkill: "process-logs\n" })
    assert.deepEqual([neverStarted.status, neverStarted.platformSkill], ["no-database", "replaced"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("file names match the log-writer's", () => {
  assert.equal(logFileName("app-frontend"), "app-frontend.log")
  assert.equal(logFileName("my worker #2"), "my_worker__2.log")
  assert.equal(logFileName(".."), "unknown.log")
})
