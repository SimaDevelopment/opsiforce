import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { composeSkills, planCompose, sharedSkillsForPackage } from "./compose-skills.mjs"

const shared = ["agent-browser", "llm-api", "platform", "sqlite"]

describe("sharedSkillsForPackage", () => {
  it("gives a built-in package the whole shared pool", () => {
    assert.deepEqual(sharedSkillsForPackage("app-builder", shared), shared)
  })

  it("gives the custom package the platform skill and nothing else", () => {
    assert.deepEqual(sharedSkillsForPackage("custom", shared), ["platform"])
  })
})

describe("composeSkills", () => {
  it("lays only platform into the custom package on disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "compose-"))
    const sharedDir = path.join(root, "skills")
    for (const name of shared) {
      await mkdir(path.join(sharedDir, name), { recursive: true })
      await writeFile(path.join(sharedDir, name, "SKILL.md"), `# ${name}\n`)
    }
    const outDir = path.join(root, "custom-skills")
    const plan = await composeSkills({ packageName: "custom", sharedDir, overridesDir: path.join(root, "none"), outDir })
    assert.deepEqual(plan, [{ name: "platform", source: "shared" }])
    assert.deepEqual(await readdir(outDir), ["platform"])
  })

  it("still lets planCompose prefer an override over a shared copy", () => {
    assert.deepEqual(planCompose(["platform", "ui"], ["ui"]), [
      { name: "platform", source: "shared" },
      { name: "ui", source: "override" },
    ])
  })
})
