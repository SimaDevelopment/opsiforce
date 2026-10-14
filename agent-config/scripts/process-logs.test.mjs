import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import test from "node:test"

const PROCESS_LOGS = path.join(path.dirname(fileURLToPath(import.meta.url)), "process-logs.sh")
const run = promisify(execFile)

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString()

async function withLogs(files, check) {
  const dir = await mkdtemp(path.join(tmpdir(), "process-logs-"))
  try {
    for (const [name, lines] of Object.entries(files)) {
      await writeFile(path.join(dir, name), lines.map((line) => `${line}\n`).join(""))
    }
    const processLogs = async (...args) =>
      (await run("bash", [PROCESS_LOGS, ...args], { env: { ...process.env, PROCESS_LOG_DIR: dir } })).stdout
    await check(processLogs)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const fixture = () => ({
  "app-backend.log.2": [`${ago(7200)} booting`],
  "app-backend.log.1": [`${ago(600)} Error: Cannot find module 'x'`],
  "app-backend.log": [
    `${ago(90)} [event] crashed exit_code=1 uptime_seconds=2 restart_count=3`,
    `${ago(30)} listening on 3000`,
  ],
  "app-frontend.log": [`${ago(60)} ready in 300 ms`],
})

test("one process reads its rotated files oldest first without a name prefix", async () => {
  await withLogs(fixture(), async (processLogs) => {
    const lines = (await processLogs("app-backend")).trim().split("\n")
    assert.equal(lines.length, 4)
    assert.match(lines[0], / booting$/)
    assert.match(lines[3], /Z listening on 3000$/)
  })
})

test("every process is merged by time and prefixed with its name", async () => {
  await withLogs(fixture(), async (processLogs) => {
    const lines = (await processLogs("--since", "2m")).trim().split("\n")
    assert.deepEqual(
      lines.map((line) => line.split(" ").slice(1, 3).join(" ")),
      ["[app-backend] [event]", "[app-frontend] ready", "[app-backend] listening"],
    )
  })
})

test("events, grep and line limits narrow the output", async () => {
  await withLogs(fixture(), async (processLogs) => {
    assert.match(await processLogs("--events"), /\[app-backend\] \[event\] crashed exit_code=1/)
    assert.equal((await processLogs("--events")).trim().split("\n").length, 1)
    assert.match(await processLogs("--grep", "cannot find|fail"), /Cannot find module/)
    assert.equal((await processLogs("-n", "1")).trim().split("\n").length, 1)
  })
})

test("a name is matched the way the writer names its file, and bad arguments say how to use it", async () => {
  await withLogs({ ...fixture(), "my_worker.log": [`${ago(5)} tick`], "my.logger.log": [`${ago(5)} hello`] }, async (processLogs) => {
    assert.match(await processLogs("my worker"), /Z tick$/m)
    assert.match(await processLogs("--list"), /^my\.logger\s/m)
    assert.match(await processLogs("--grep", "Cannot\\s+find"), /Cannot find module/)
    await assert.rejects(processLogs("--since"), /needs a value/)
    await assert.rejects(processLogs("-n", "ten"), /whole number/)
  })
})

test("list shows each process with its last write", async () => {
  await withLogs(fixture(), async (processLogs) => {
    const output = await processLogs("--list")
    assert.match(output, /^app-backend\s+\d{4}-\d\d-\d\dT/m)
    assert.match(output, /^app-frontend\s+\d{4}-\d\d-\d\dT/m)
  })
})

test("a missing log directory is not an error", async () => {
  const { stdout } = await run("bash", [PROCESS_LOGS], {
    env: { ...process.env, PROCESS_LOG_DIR: path.join(tmpdir(), "process-logs-missing") },
  })
  assert.equal(stdout, "")
})
