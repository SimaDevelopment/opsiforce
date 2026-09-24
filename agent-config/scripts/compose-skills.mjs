#!/usr/bin/env node
import { constants } from "node:fs"
import { access, cp, mkdir, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"

export const CUSTOM_PACKAGE = "custom"
export const CUSTOM_PACKAGE_SHARED_SKILLS = ["platform"]
export const PACKAGE_SHARED_SKILL_EXCLUSIONS = { "makara-app-builder": ["web-app"] }

export function sharedSkillsForPackage(packageName, sharedNames) {
  if (packageName === CUSTOM_PACKAGE) return sharedNames.filter((name) => CUSTOM_PACKAGE_SHARED_SKILLS.includes(name))
  const excluded = PACKAGE_SHARED_SKILL_EXCLUSIONS[packageName] ?? []
  return sharedNames.filter((name) => !excluded.includes(name))
}

export function planCompose(sharedNames, overrideNames) {
  const overrides = new Set(overrideNames)
  const names = [...new Set([...sharedNames, ...overrideNames])].sort()
  return names.map((name) => ({
    name,
    source: overrides.has(name) ? "override" : "shared",
  }))
}

async function listSkillDirs(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

export async function composeSkills({ packageName, sharedDir, overridesDir, outDir }) {
  const plan = planCompose(
    sharedSkillsForPackage(packageName, await listSkillDirs(sharedDir)),
    await listSkillDirs(overridesDir),
  )
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const { name, source } of plan) {
    const from = path.join(source === "override" ? overridesDir : sharedDir, name)
    await cp(from, path.join(outDir, name), { recursive: true, dereference: true })
  }
  return plan
}

async function exists(target) {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function composeAgentsRoot(sharedDir, agentsRoot) {
  for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillsDir = path.join(agentsRoot, entry.name, "skills")
    const stagingDir = path.join(agentsRoot, entry.name, ".skills-composed")
    const plan = await composeSkills({ packageName: entry.name, sharedDir, overridesDir: skillsDir, outDir: stagingDir })
    if (await exists(skillsDir)) await rm(skillsDir, { recursive: true, force: true })
    await rename(stagingDir, skillsDir)
    console.log(`${entry.name}: composed ${plan.length} skills (${plan.filter((s) => s.source === "override").length} override)`)
  }
}

async function main() {
  const [sharedDir, agentsRoot] = process.argv.slice(2)
  if (!sharedDir || !agentsRoot) {
    console.error("usage: compose-skills.mjs <sharedDir> <agentsRoot>")
    process.exit(1)
  }
  await composeAgentsRoot(sharedDir, agentsRoot)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
