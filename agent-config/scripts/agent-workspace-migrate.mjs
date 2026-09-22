#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"

const GITIGNORE = [
  ".config/",
  ".cache/",
  ".bun/",
  ".opencode/",
  ".opsiforce/",
  ".xdg/",
  "node_modules/",
  "data/",
  "**/.yarn/cache",
  "**/.yarn/unplugged",
  "**/.yarn/build-state.yml",
  "**/.yarn/install-state.gz",
  "**/.yarn/sdks",
  "**/.pnp.*",
  "",
].join("\n")

export function createContext(env = process.env) {
  const agentName = env.AGENT_NAME || "app-builder"
  const workspace = env.WORKSPACE || "/workspace"
  const agentsRoot = env.AGENTS_ROOT || "/opt/agents"
  const opencodeRoot = env.OPENCODE_ROOT || "/opt/opencode"
  const agentRoot = path.join(agentsRoot, agentName)
  const agentStateDir = path.join(workspace, ".opsiforce", "agents")
  return {
    env,
    agentName,
    workspace,
    agentsRoot,
    opencodeRoot,
    agentRoot,
    agentStateDir,
    ledgerPath: path.join(agentStateDir, `${agentName}.json`),
    summaryPath: path.join(agentStateDir, `${agentName}.summary.json`),
    stagingRoot: path.join(workspace, ".opsiforce", "staging"),
    opencodeDir: path.join(workspace, ".opencode"),
    opencodeConfigPath: path.join(workspace, ".opencode", "opencode.json"),
    promptDir: path.join(workspace, ".opencode", "agents"),
    skillsDir: path.join(workspace, ".opencode", "skills"),
    packageSkillsDir: path.join(agentRoot, "skills"),
    packagePromptPath: path.join(agentRoot, "agent.md"),
    packageTemplateDir: path.join(agentRoot, "template"),
    appDir: path.join(workspace, "app"),
  }
}

export function createSummary(context) {
  return {
    agentName: context.agentName,
    targetVersion: context.env.TARGET_VERSION || "unknown",
    appliedMigrations: [],
    skippedMigrations: [],
    failedMigrations: [],
    conflicts: [],
    skippedSkills: [],
    ownedSkills: { written: [], removed: [] },
    configChanged: false,
    requiresPodRecreate: false,
    status: "applied",
  }
}

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch {
    return fallback
  }
}

async function writeTextAtomic(filePath, contents) {
  const directory = path.dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(filePath)}.tmp-${randomUUID()}`)
  await writeFile(temporary, contents)
  await rename(temporary, filePath)
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeJson(filePath, value) {
  await writeTextAtomic(filePath, serializeJson(value))
}

/** Returns whether the bytes actually changed, so the Job result can report `configChanged`. */
async function writeJsonIfChanged(filePath, value) {
  const next = serializeJson(value)
  const current = await readFile(filePath, "utf8").catch(() => null)
  if (current === next) return false
  await writeTextAtomic(filePath, next)
  return true
}

async function copyFileAtomic(source, target) {
  const directory = path.dirname(target)
  await mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${path.basename(target)}.tmp-${randomUUID()}`)
  await cp(source, temporary, { dereference: true })
  await rename(temporary, target)
}

async function listDirs(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

async function listFilesRecursive(directory, prefix = "") {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(path.join(directory, entry.name), relative)))
    else files.push(relative)
  }
  return files
}

async function loadRegistryEntry(context) {
  const registry = await readJson(path.join(context.agentsRoot, "agents.json"), {})
  const agents = registry && typeof registry === "object" ? registry.agents : null
  const entry = agents && typeof agents === "object" ? agents[context.agentName] : null
  return entry && typeof entry === "object" ? entry : {}
}

async function loadImageVersion(context) {
  if (context.env.AGENT_IMAGE_VERSION) return context.env.AGENT_IMAGE_VERSION
  const file = await readJson(path.join(context.opencodeRoot, "agent-image-version.json"), {})
  return typeof file.version === "string" && file.version.length > 0 ? file.version : "unknown"
}

function joinModelRef(model, variant) {
  return model && variant ? `${model}#${variant}` : model
}

export function buildOpenCodeConfig({ imageConfig, existingConfig, packageName, packageAgents, registryEntry, modelEnv, variantEnv }) {
  const image = imageConfig && typeof imageConfig === "object" ? imageConfig : {}
  const existing = existingConfig && typeof existingConfig === "object" ? existingConfig : {}
  const next = { ...image }
  delete next.default_agent

  const existingAgents = existing.agents && typeof existing.agents === "object" ? existing.agents : {}
  const imageAgents = image.agents && typeof image.agents === "object" ? image.agents : {}
  const agents = { ...imageAgents }
  for (const [slug, block] of Object.entries(existingAgents)) {
    if (packageAgents.includes(slug) || slug in imageAgents) continue
    agents[slug] = block
  }

  if (packageAgents.includes(packageName)) {
    const model = modelEnv || registryEntry?.model || image.model || ""
    const variant = variantEnv || registryEntry?.variant || ""
    const reference = joinModelRef(model, variant)
    if (reference) {
      next.model = reference
      agents[packageName] = { ...(imageAgents[packageName] ?? {}), model: reference }
    }
  } else if (typeof existing.model === "string" && existing.model.length > 0) {
    next.model = existing.model
  }

  next.agents = agents
  if (typeof existing.default_agent === "string" && existing.default_agent.length > 0) {
    next.default_agent = existing.default_agent
  }
  return next
}

export function planSkills({ packageSkills, presentSkills, ownedSkills, builtInPackage }) {
  const present = new Set(presentSkills)
  const owned = new Set(ownedSkills)
  const write = []
  const skip = []
  for (const name of packageSkills) {
    if (present.has(name) && !owned.has(name) && !builtInPackage) skip.push(name)
    else write.push(name)
  }
  const written = new Set(write)
  const remove = ownedSkills.filter((name) => !written.has(name) && present.has(name))
  return { write, skip, remove }
}

async function writeSkill(context, name) {
  const source = path.join(context.packageSkillsDir, name)
  const target = path.join(context.skillsDir, name)
  if (!(await exists(target))) {
    const staging = path.join(context.stagingRoot, randomUUID())
    await mkdir(staging, { recursive: true })
    await cp(source, path.join(staging, name), { recursive: true, dereference: true })
    await mkdir(context.skillsDir, { recursive: true })
    await rename(path.join(staging, name), target)
    await rm(staging, { recursive: true, force: true })
    return
  }
  const sourceFiles = await listFilesRecursive(source)
  for (const relative of sourceFiles) {
    await copyFileAtomic(path.join(source, relative), path.join(target, relative))
  }
  const keep = new Set(sourceFiles)
  for (const relative of await listFilesRecursive(target)) {
    if (!keep.has(relative)) await rm(path.join(target, relative), { force: true })
  }
}

async function applyContent(context, summary, ownedSkills) {
  const registryEntry = await loadRegistryEntry(context)
  const packageShipsPrompt = await exists(context.packagePromptPath)
  const packageAgents = packageShipsPrompt ? [context.agentName] : []

  const config = buildOpenCodeConfig({
    imageConfig: await readJson(path.join(context.opencodeRoot, "opencode.json"), {}),
    existingConfig: await readJson(context.opencodeConfigPath, {}),
    packageName: context.agentName,
    packageAgents,
    registryEntry,
    modelEnv: context.env.AGENT_MODEL,
    variantEnv: context.env.AGENT_VARIANT,
  })
  summary.configChanged = await writeJsonIfChanged(context.opencodeConfigPath, config)

  if (packageShipsPrompt) {
    await mkdir(context.promptDir, { recursive: true })
    await copyFileAtomic(context.packagePromptPath, path.join(context.promptDir, `${context.agentName}.md`))
  }

  const plan = planSkills({
    packageSkills: await listDirs(context.packageSkillsDir),
    presentSkills: await listDirs(context.skillsDir),
    ownedSkills,
    builtInPackage: packageShipsPrompt,
  })
  for (const name of plan.write) await writeSkill(context, name)
  for (const name of plan.remove) await rm(path.join(context.skillsDir, name), { recursive: true, force: true })
  summary.skippedSkills = plan.skip
  summary.ownedSkills = { written: plan.write, removed: plan.remove }

  return { ownedSkills: plan.write, packageShipsPrompt, registryEntry }
}

async function layTemplate(context) {
  if (await exists(context.appDir)) return false
  if (!(await exists(context.packageTemplateDir))) return false
  await cp(context.packageTemplateDir, context.workspace, { recursive: true })
  return true
}

function runGit(context, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: context.workspace }, (error) => (error ? reject(error) : resolve()))
  })
}

async function initRepository(context, laidTemplate) {
  if (await exists(path.join(context.workspace, ".git"))) return
  if (!(await exists(path.join(context.workspace, ".gitignore")))) {
    await writeTextAtomic(path.join(context.workspace, ".gitignore"), GITIGNORE)
  }
  await runGit(context, ["init"])
  await runGit(context, ["config", "user.email", "agent@opsiforce.com"])
  await runGit(context, ["config", "user.name", "OpsiForce"])
  await runGit(context, ["add", "-A"])
  await runGit(context, ["commit", "--allow-empty", "-m", laidTemplate ? "Initial template" : "Initial workspace"])
}

function recordConflict(summary, migrationId, target, reason) {
  summary.conflicts.push({ migrationId, path: target, reason })
}

async function fileHash(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex")
}

async function checkManagedTarget(context, target, checksums) {
  const absolute = path.join(context.workspace, target)
  if (!(await exists(absolute))) return { ok: false, reason: "missing" }
  if (!Array.isArray(checksums) || checksums.length === 0) return { ok: false, reason: "missing managed checksum" }
  const current = await fileHash(absolute)
  if (!checksums.includes(current)) return { ok: false, reason: "checksum mismatch" }
  return { ok: true, reason: "" }
}

function mergeJson(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch
  const source = base && typeof base === "object" && !Array.isArray(base) ? base : {}
  const next = { ...source }
  for (const [key, value] of Object.entries(patch)) {
    next[key] = mergeJson(source[key], value)
  }
  return next
}

async function runShellCommand(context, operation, migrationDir) {
  const cwd = path.join(context.workspace, operation.cwd || ".")
  const expand = (value) => String(value).replaceAll("${MIGRATION_DIR}", migrationDir)
  const command = typeof operation.command === "string" ? expand(operation.command) : ""
  if (command.length === 0) throw new Error("migration command is required")
  const args = Array.isArray(operation.args) ? operation.args.map(expand) : []
  await new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd,
      timeout: Number(operation.timeoutSeconds || 300) * 1000,
      env: { ...process.env, MIGRATION_DIR: migrationDir },
    }, (error) => {
      if (error) reject(error)
      else resolve()
    })
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
  })
}

async function applyOperation(context, summary, migrationId, migrationDir, operation) {
  if (!operation || typeof operation !== "object") return
  const target = typeof operation.target === "string" ? operation.target : ""
  const absoluteTarget = path.join(context.workspace, target)

  if (operation.type === "copy") {
    const source = typeof operation.source === "string" ? path.join(migrationDir, operation.source) : ""
    if (!source || !target) throw new Error(`Invalid copy operation in ${migrationId}`)
    const targetExists = await exists(absoluteTarget)
    if (targetExists && operation.ifMissing) return
    if (targetExists) {
      const check = await checkManagedTarget(context, target, operation.managedChecksums)
      if (!check.ok) {
        recordConflict(summary, migrationId, target, check.reason)
        return
      }
    }
    await mkdir(path.dirname(absoluteTarget), { recursive: true })
    await cp(source, absoluteTarget, { recursive: true })
    return
  }

  if (operation.type === "delete") {
    const check = await checkManagedTarget(context, target, operation.managedChecksums)
    if (!check.ok) {
      recordConflict(summary, migrationId, target, check.reason)
      return
    }
    await rm(absoluteTarget, { recursive: true, force: true })
    return
  }

  if (operation.type === "chmod") {
    if (!target || !(await exists(absoluteTarget))) return
    await chmod(absoluteTarget, Number.parseInt(String(operation.mode || "755"), 8))
    return
  }

  if (operation.type === "jsonMerge") {
    const targetExists = await exists(absoluteTarget)
    if (targetExists) {
      const check = await checkManagedTarget(context, target, operation.managedChecksums)
      if (!check.ok) {
        recordConflict(summary, migrationId, target, check.reason)
        return
      }
    }
    const current = await readJson(absoluteTarget, {})
    await writeJson(absoluteTarget, mergeJson(current, operation.value || {}))
    return
  }

  if (operation.type === "command") {
    await runShellCommand(context, operation, migrationDir)
  }
}

async function loadMigrations(context) {
  const root = path.join(context.agentRoot, "migrations")
  if (!(await exists(root))) return []
  const entries = await readdir(root, { withFileTypes: true })
  const migrations = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const migration = await readJson(path.join(dir, "migration.json"), undefined)
    if (!migration || typeof migration.id !== "string") continue
    migrations.push({ dir, migration })
  }
  return migrations.sort((a, b) => a.migration.id.localeCompare(b.migration.id))
}

async function applyWorkspaceMigrations(context, summary, alreadyApplied) {
  for (const item of await loadMigrations(context)) {
    const migration = item.migration
    if (alreadyApplied.has(migration.id)) {
      summary.skippedMigrations.push(migration.id)
      continue
    }
    const operations = Array.isArray(migration.operations) ? migration.operations : []
    const conflictsBefore = summary.conflicts.length
    try {
      for (const operation of operations) {
        await applyOperation(context, summary, migration.id, item.dir, operation)
      }
    } catch (error) {
      summary.failedMigrations.push({
        migrationId: migration.id,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    if (summary.conflicts.length > conflictsBefore) continue
    summary.appliedMigrations.push(migration.id)
    if (migration.requiresPodRecreate) summary.requiresPodRecreate = true
  }
}

async function writeLedger(context, { contentVersion, imageVersion, ownedSkills, appliedMigrations }) {
  await writeJson(context.ledgerPath, {
    package: context.agentName,
    contentVersion,
    imageVersion,
    ownedSkills,
    appliedMigrations,
    updatedAt: new Date().toISOString(),
  })
}

async function resolveContentVersion(context, registryEntry, imageVersion) {
  if (context.env.TARGET_VERSION) return context.env.TARGET_VERSION
  if (typeof registryEntry.version === "string" && registryEntry.version.length > 0) return registryEntry.version
  return imageVersion
}

async function clearStaging(context) {
  await rm(context.stagingRoot, { recursive: true, force: true })
}

export async function provisionWorkspace(context, summary) {
  if (await exists(context.ledgerPath)) {
    summary.status = "skipped"
    return summary
  }
  await clearStaging(context)
  const { ownedSkills, registryEntry } = await applyContent(context, summary, [])
  const laidTemplate = await layTemplate(context)
  if (!laidTemplate) await mkdir(context.appDir, { recursive: true })
  await initRepository(context, laidTemplate)
  const imageVersion = await loadImageVersion(context)
  summary.targetVersion = await resolveContentVersion(context, registryEntry, imageVersion)
  await writeLedger(context, {
    contentVersion: summary.targetVersion,
    imageVersion,
    ownedSkills,
    appliedMigrations: [],
  })
  await clearStaging(context)
  return summary
}

export async function reconcileContent(context, summary, { withMigrations = false } = {}) {
  await clearStaging(context)
  const provisioned = await exists(context.ledgerPath)
  const ledger = provisioned ? await readJson(context.ledgerPath, {}) : {}
  const previouslyApplied = Array.isArray(ledger.appliedMigrations) ? ledger.appliedMigrations : []
  const adopted = Array.isArray(ledger.ownedSkills)
    ? ledger.ownedSkills
    : provisioned
      ? await listDirs(context.skillsDir)
      : []
  const { ownedSkills, registryEntry } = await applyContent(context, summary, adopted)

  if (withMigrations) await applyWorkspaceMigrations(context, summary, new Set(previouslyApplied))

  if (summary.conflicts.length > 0) summary.status = "conflict"
  const imageVersion = await loadImageVersion(context)
  summary.targetVersion = await resolveContentVersion(context, registryEntry, imageVersion)
  await writeLedger(context, {
    contentVersion: summary.targetVersion,
    imageVersion,
    ownedSkills,
    appliedMigrations: Array.from(new Set([...previouslyApplied, ...summary.appliedMigrations])),
  })
  await clearStaging(context)
  return summary
}

async function run() {
  const context = createContext()
  const summary = createSummary(context)
  const mode = process.argv.includes("--sync-agent-files")
    ? provisionWorkspace
    : (ctx, sum) => reconcileContent(ctx, sum, { withMigrations: process.argv.includes("--migrate") })
  try {
    await mode(context, summary)
  } catch (error) {
    summary.status = "failed"
    summary.error = error instanceof Error ? error.message : String(error)
    await writeJson(context.summaryPath, summary).catch(() => {})
    console.log(JSON.stringify(summary))
    process.exit(1)
  }
  if (summary.status !== "skipped") await writeJson(context.summaryPath, summary)
  console.log(JSON.stringify(summary))
}

if (import.meta.url === `file://${process.argv[1]}`) await run()
