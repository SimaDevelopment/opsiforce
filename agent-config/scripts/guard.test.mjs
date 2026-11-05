import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
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

async function guardWith(...args) {
  const { code = 0, stdout, stderr } = await promisify(execFile)("bash", [GUARD, ...args], { timeout: 3000 }).catch(
    (error) => error,
  )
  return { code, stdout, stderr }
}

for (const flag of ["--help", "-h"]) {
  test(`guard ${flag} prints its usage and exits without supervising anything`, async () => {
    const { code, stdout } = await guardWith(flag)
    assert.equal(code, 0)
    assert.match(stdout, /guard <name> <command>/)
  })
}

for (const args of [[], ["service"], ["--name", "service", "sleep", "1"]]) {
  test(`guard ${args.join(" ") || "with no arguments"} is refused with its usage instead of a restart loop`, async () => {
    const { code, stdout, stderr } = await guardWith(...args)
    assert.equal(code, 2)
    assert.equal(stdout, "")
    assert.match(stderr, /guard <name> <command>/)
  })
}
