import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "guard.sh")

async function runsAfter(command, milliseconds) {
  const dir = await mkdtemp(path.join(tmpdir(), "guard-"))
  const runs = path.join(dir, "runs")
  const guard = spawn("bash", [GUARD, "test-service", "sh", "-c", `echo run >> ${runs}; ${command}`], {
    detached: true,
    stdio: "ignore",
  })
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
  process.kill(-guard.pid, "SIGKILL")
  const count = (await readFile(runs, "utf8").catch(() => "")).split("\n").filter(Boolean).length
  await rm(dir, { recursive: true, force: true })
  return count
}

test("a supervised command that exits cleanly is started again", async () => {
  assert.ok((await runsAfter("exit 0", 3500)) >= 2)
})

test("a supervised command that crashes is started again", async () => {
  assert.ok((await runsAfter("exit 3", 3500)) >= 2)
})
