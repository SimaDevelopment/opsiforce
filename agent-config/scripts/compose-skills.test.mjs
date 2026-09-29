import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CUSTOM_PACKAGE_SHARED_SKILLS,
  PACKAGE_SHARED_SKILL_EXCLUSIONS,
  composeSkills,
  planCompose,
  sharedSkillsForPackage,
} from "./compose-skills.mjs"

const shared = ["agent-browser", "dates", "llm-api", "platform", "sqlite", "web-app"]

describe("sharedSkillsForPackage", () => {
  it("gives a built-in package the whole shared pool", () => {
    assert.deepEqual(sharedSkillsForPackage("app-builder", shared), shared)
  })

  it("leaves the shadcn web-app skill and the shared dates skill out of the Makara package, which carries its own", () => {
    assert.deepEqual(sharedSkillsForPackage("makara-app-builder", shared), ["agent-browser", "llm-api", "platform", "sqlite"])
  })

  it("gives the Skill & Agent Builder only platform, web-app and agent-browser from the shared pool", () => {
    assert.deepEqual(sharedSkillsForPackage("skill-agent-builder", shared), ["agent-browser", "platform", "web-app"])
  })

  it("gives the custom package the platform skill and nothing else", () => {
    assert.deepEqual(sharedSkillsForPackage("custom", shared), ["platform"])
  })

  it("reads its rules from package-skills.json, the file the backend's Store and delivery read too", async () => {
    const rules = JSON.parse(await readFile(new URL("../package-skills.json", import.meta.url), "utf8"))
    assert.deepEqual(PACKAGE_SHARED_SKILL_EXCLUSIONS, rules.sharedSkillExclusions)
    assert.deepEqual(CUSTOM_PACKAGE_SHARED_SKILLS, rules.customPackageSharedSkills)
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
