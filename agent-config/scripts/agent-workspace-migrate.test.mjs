import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  buildOpenCodeConfig,
  createContext,
  createSummary,
  planSkills,
  provisionWorkspace,
  reconcileContent,
} from "./agent-workspace-migrate.mjs"

const IMAGE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  update: "disable",
  agents: { build: { disabled: true } },
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "edit", resource: ".opencode/**", effect: "deny" },
  ],
  model: "openai/gpt-5.6-sol",
}

const REGISTRY = { agents: { "app-builder": { version: "0.2.0", model: "openai/gpt-6-astra", variant: "high" } } }

async function makeRoots({ packages = ["app-builder"], skills = { "app-builder": ["charts", "ui"] } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-migrate-"))
  const workspace = path.join(root, "workspace")
  const agentsRoot = path.join(root, "agents")
  const opencodeRoot = path.join(root, "opencode")
  await mkdir(workspace, { recursive: true })
  await mkdir(opencodeRoot, { recursive: true })
  await writeFile(path.join(opencodeRoot, "opencode.json"), JSON.stringify(IMAGE_CONFIG))
  await writeFile(path.join(opencodeRoot, "agent-image-version.json"), JSON.stringify({ version: "0.11.0" }))
  await mkdir(agentsRoot, { recursive: true })
  await writeFile(path.join(agentsRoot, "agents.json"), JSON.stringify(REGISTRY))
  for (const name of packages) {
    await mkdir(path.join(agentsRoot, name), { recursive: true })
    if (name !== "custom") {
      await writeFile(path.join(agentsRoot, name, "agent.md"), `# ${name}\n`)
      await mkdir(path.join(agentsRoot, name, "template"), { recursive: true })
      await mkdir(path.join(agentsRoot, name, "template", "app"), { recursive: true })
      await writeFile(path.join(agentsRoot, name, "template", "app", "startup.sh"), "#!/bin/sh\n")
    }
    for (const skill of skills[name] ?? []) {
      await mkdir(path.join(agentsRoot, name, "skills", skill), { recursive: true })
      await writeFile(path.join(agentsRoot, name, "skills", skill, "SKILL.md"), `# ${skill} v1\n`)
    }
  }
  return { root, workspace, agentsRoot, opencodeRoot }
}

function contextFor(roots, agentName) {
  return createContext({
    AGENT_NAME: agentName,
    WORKSPACE: roots.workspace,
    AGENTS_ROOT: roots.agentsRoot,
    OPENCODE_ROOT: roots.opencodeRoot,
  })
}

function summaryFor(context) {
  return createSummary(context)
}

async function readLedger(context) {
  return JSON.parse(await readFile(context.ledgerPath, "utf8"))
}

async function readConfig(context) {
  return JSON.parse(await readFile(context.opencodeConfigPath, "utf8"))
}

test("buildOpenCodeConfig starts from the image and drops keys the image removed", () => {
  const config = buildOpenCodeConfig({
    imageConfig: IMAGE_CONFIG,
    existingConfig: { ...IMAGE_CONFIG, retired_key: true, default_agent: "app-builder" },
    packageName: "app-builder",
    packageAgents: ["app-builder"],
    registryEntry: REGISTRY.agents["app-builder"],
  })
  assert.equal(config.retired_key, undefined)
  assert.deepEqual(config.permissions, IMAGE_CONFIG.permissions)
})

test("buildOpenCodeConfig carries default_agent forward and never invents one", () => {
  const carried = buildOpenCodeConfig({
    imageConfig: IMAGE_CONFIG,
    existingConfig: { default_agent: "acme-support" },
    packageName: "custom",
    packageAgents: [],
    registryEntry: {},
  })
  assert.equal(carried.default_agent, "acme-support")

  const unwritten = buildOpenCodeConfig({
    imageConfig: IMAGE_CONFIG,
    existingConfig: {},
    packageName: "app-builder",
    packageAgents: ["app-builder"],
    registryEntry: REGISTRY.agents["app-builder"],
  })
  assert.equal("default_agent" in unwritten, false)
})

test("buildOpenCodeConfig keeps foreign agent blocks and rewrites the package model", () => {
  const config = buildOpenCodeConfig({
    imageConfig: IMAGE_CONFIG,
    existingConfig: {
      default_agent: "acme-support",
      agents: {
        "acme-support": { model: "anthropic/claude-opus-5", mode: "primary" },
        "app-builder": { model: "openai/stale-model#low", temperature: 0.9 },
      },
    },
    packageName: "app-builder",
    packageAgents: ["app-builder"],
    registryEntry: REGISTRY.agents["app-builder"],
  })
  assert.deepEqual(config.agents["acme-support"], { model: "anthropic/claude-opus-5", mode: "primary" })
  assert.deepEqual(config.agents["app-builder"], { model: "openai/gpt-6-astra#high" })
  assert.equal(config.agents.build.disabled, true)
  assert.equal(config.model, "openai/gpt-6-astra#high")
})

test("buildOpenCodeConfig keeps the existing top-level model for the custom package", () => {
  const config = buildOpenCodeConfig({
    imageConfig: IMAGE_CONFIG,
    existingConfig: { model: "anthropic/claude-sonnet-5", agents: { "acme-support": { mode: "primary" } } },
    packageName: "custom",
    packageAgents: [],
    registryEntry: {},
  })
  assert.equal(config.model, "anthropic/claude-sonnet-5")
  assert.equal(config.agents["custom"], undefined)
})

test("planSkills lets a built-in package take a colliding name and a custom package skip it", () => {
  const builtIn = planSkills({
    packageSkills: ["charts", "ui"],
    presentSkills: ["charts", "org-skill"],
    ownedSkills: ["ui"],
    builtInPackage: true,
  })
  assert.deepEqual(builtIn.write, ["charts", "ui"])
  assert.deepEqual(builtIn.skip, [])
  assert.deepEqual(builtIn.remove, [])

  const custom = planSkills({
    packageSkills: ["charts", "ui"],
    presentSkills: ["charts"],
    ownedSkills: [],
    builtInPackage: false,
  })
  assert.deepEqual(custom.write, ["ui"])
  assert.deepEqual(custom.skip, ["charts"])
  assert.deepEqual(custom.write, ["ui"])
})

test("planSkills removes only owned names the image dropped", () => {
  const plan = planSkills({
    packageSkills: ["ui"],
    presentSkills: ["ui", "charts", "org-skill"],
    ownedSkills: ["ui", "charts"],
    builtInPackage: true,
  })
  assert.deepEqual(plan.remove, ["charts"])
  assert.deepEqual(plan.write, ["ui"])
})

test("first boot lays every owned file and writes the ledger last", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))

  const ledger = await readLedger(context)
  assert.deepEqual(ledger.ownedSkills, ["charts", "ui"])
  assert.equal(ledger.contentVersion, "0.2.0")
  assert.equal(ledger.imageVersion, "0.11.0")
  assert.equal(ledger.package, "app-builder")

  const ledgerAt = (await stat(context.ledgerPath)).mtimeMs
  for (const file of [
    context.opencodeConfigPath,
    path.join(context.promptDir, "app-builder.md"),
    path.join(context.skillsDir, "ui", "SKILL.md"),
    path.join(roots.workspace, "app", "startup.sh"),
  ]) {
    assert.ok((await stat(file)).mtimeMs <= ledgerAt, `${file} was written after the ledger`)
  }
  assert.ok((await stat(path.join(roots.workspace, ".git"))).isDirectory())
})

test("second boot writes nothing", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  await writeFile(path.join(context.promptDir, "app-builder.md"), "user edited\n")

  const summary = summaryFor(context)
  await provisionWorkspace(context, summary)
  assert.equal(summary.status, "skipped")
  assert.equal(await readFile(path.join(context.promptDir, "app-builder.md"), "utf8"), "user edited\n")
})

test("a publish target with a cloned tree and no ledger still provisions", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  await mkdir(path.join(roots.workspace, "app"), { recursive: true })
  await writeFile(path.join(roots.workspace, "app", "startup.sh"), "cloned\n")
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))

  assert.equal(await readFile(path.join(roots.workspace, "app", "startup.sh"), "utf8"), "cloned\n")
  assert.deepEqual((await readLedger(context)).ownedSkills, ["charts", "ui"])
})

test("first boot keeps skills the backend wrote before the pod existed", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await mkdir(path.join(context.skillsDir, "org-skill"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "org-skill", "SKILL.md"), "# org\n")

  await provisionWorkspace(context, summaryFor(context))
  assert.deepEqual(await readdir(context.skillsDir), ["charts", "org-skill", "ui"])
  assert.deepEqual((await readLedger(context)).ownedSkills, ["charts", "ui"])
})

test("first boot on a custom package keeps a pinned skill the image also ships", async (t) => {
  const roots = await makeRoots({ packages: ["custom"], skills: { custom: ["llm-api"] } })
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "custom")
  await mkdir(path.join(context.skillsDir, "llm-api"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "llm-api", "SKILL.md"), "# pinned snapshot\n")

  const summary = summaryFor(context)
  await provisionWorkspace(context, summary)
  assert.equal(await readFile(path.join(context.skillsDir, "llm-api", "SKILL.md"), "utf8"), "# pinned snapshot\n")
  assert.deepEqual(summary.skippedSkills, ["llm-api"])
  assert.deepEqual((await readLedger(context)).ownedSkills, [])
})

test("first boot on a built-in package takes a colliding skill name", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await mkdir(path.join(context.skillsDir, "ui"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "ui", "SKILL.md"), "# backend copy\n")

  await provisionWorkspace(context, summaryFor(context))
  assert.equal(await readFile(path.join(context.skillsDir, "ui", "SKILL.md"), "utf8"), "# ui v1\n")
  assert.deepEqual((await readLedger(context)).ownedSkills, ["charts", "ui"])
})

test("the custom package provisions an empty app tree and a repository", async (t) => {
  const roots = await makeRoots({ packages: ["custom"], skills: { custom: ["llm-api"] } })
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "custom")
  await provisionWorkspace(context, summaryFor(context))

  assert.deepEqual(await readdir(path.join(roots.workspace, "app")), [])
  assert.ok((await stat(path.join(roots.workspace, ".git"))).isDirectory())
  assert.deepEqual((await readLedger(context)).ownedSkills, ["llm-api"])
  assert.equal(await readFile(path.join(context.skillsDir, "llm-api", "SKILL.md"), "utf8"), "# llm-api v1\n")
  assert.equal((await readdir(context.promptDir).catch(() => [])).length, 0)
})

test("the custom package versions its content by the image", async (t) => {
  const roots = await makeRoots({ packages: ["custom"], skills: { custom: [] } })
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "custom")
  await provisionWorkspace(context, summaryFor(context))
  assert.equal((await readLedger(context)).contentVersion, "0.11.0")
})

test("reconcile carries default_agent and foreign agent blocks", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))

  const config = await readConfig(context)
  config.default_agent = "acme-support"
  config.agents["acme-support"] = { mode: "primary" }
  config.agents["app-builder"] = { model: "openai/stale-model#low" }
  await writeFile(context.opencodeConfigPath, JSON.stringify(config))

  await reconcileContent(context, summaryFor(context))
  const next = await readConfig(context)
  assert.equal(next.default_agent, "acme-support")
  assert.deepEqual(next.agents["acme-support"], { mode: "primary" })
  assert.deepEqual(next.agents["app-builder"], { model: "openai/gpt-6-astra#high" })
})

test("reconcile removes a dropped owned skill and leaves a foreign one alone", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  await mkdir(path.join(context.skillsDir, "org-skill"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "org-skill", "SKILL.md"), "# org\n")

  await rm(path.join(roots.agentsRoot, "app-builder", "skills", "charts"), { recursive: true, force: true })
  await writeFile(path.join(roots.agentsRoot, "app-builder", "skills", "ui", "SKILL.md"), "# ui v2\n")

  await reconcileContent(context, summaryFor(context))
  assert.deepEqual(await readdir(context.skillsDir), ["org-skill", "ui"])
  assert.equal(await readFile(path.join(context.skillsDir, "ui", "SKILL.md"), "utf8"), "# ui v2\n")
  assert.deepEqual((await readLedger(context)).ownedSkills, ["ui"])
})

test("a ledger without ownedSkills adopts what is present, once", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  await mkdir(path.join(context.skillsDir, "legacy-skill"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "legacy-skill", "SKILL.md"), "# legacy\n")
  const legacy = await readLedger(context)
  delete legacy.ownedSkills
  await writeFile(context.ledgerPath, JSON.stringify(legacy))

  await reconcileContent(context, summaryFor(context))
  assert.equal(await readdir(context.skillsDir).then((names) => names.includes("legacy-skill")), false)
  assert.deepEqual((await readLedger(context)).ownedSkills, ["charts", "ui"])

  await mkdir(path.join(context.skillsDir, "org-skill"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "org-skill", "SKILL.md"), "# org\n")
  await reconcileContent(context, summaryFor(context))
  assert.ok((await readdir(context.skillsDir)).includes("org-skill"))
})

test("reconcile on an unprovisioned workspace adopts nothing and keeps foreign skills", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await mkdir(path.join(context.skillsDir, "org-skill"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "org-skill", "SKILL.md"), "# org\n")

  await reconcileContent(context, summaryFor(context))
  assert.deepEqual(await readdir(context.skillsDir), ["charts", "org-skill", "ui"])
  assert.deepEqual((await readLedger(context)).ownedSkills, ["charts", "ui"])
})

test("a skipped first boot writes no summary file", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  await rm(context.summaryPath, { force: true })

  const summary = summaryFor(context)
  await provisionWorkspace(context, summary)
  assert.equal(summary.status, "skipped")
  assert.equal(await stat(context.summaryPath).catch(() => null), null)
})

test("reconcile leaves no discoverable temporary entries under skills", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  await reconcileContent(context, summaryFor(context))

  for (const name of await readdir(context.skillsDir)) {
    assert.ok(!name.includes(".tmp-"), name)
    for (const entry of await readdir(path.join(context.skillsDir, name))) {
      assert.ok(!entry.endsWith(".md") || entry === "SKILL.md", entry)
    }
  }
  assert.equal(await readdir(context.stagingRoot).catch(() => null), null)
})

async function writeMigration(roots, agentName, id, migration) {
  const dir = path.join(roots.agentsRoot, agentName, "migrations", id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "migration.json"), JSON.stringify({ id, ...migration }))
  return dir
}

test("the ledger carries only the current keys", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")

  await provisionWorkspace(context, summaryFor(context))
  const ledger = await readLedger(context)

  assert.deepEqual(Object.keys(ledger).toSorted(), [
    "appliedMigrations",
    "contentVersion",
    "imageVersion",
    "ownedSkills",
    "package",
    "updatedAt",
  ])
  assert.equal(ledger.package, "app-builder")
  assert.equal(ledger.contentVersion, "0.2.0")
  assert.equal(ledger.imageVersion, "0.11.0")
})

test("content mode applies no migration and never asks for a pod recreate", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  const dir = await writeMigration(roots, "app-builder", "0001-baked-binary", {
    requiresPodRecreate: true,
    operations: [{ type: "copy", source: "note.txt", target: "app/note.txt" }],
  })
  await writeFile(path.join(dir, "note.txt"), "migrated\n")

  const summary = await reconcileContent(context, summaryFor(context), { withMigrations: false })

  assert.equal(summary.requiresPodRecreate, false)
  assert.deepEqual(summary.appliedMigrations, [])
  assert.equal(await readFile(path.join(roots.workspace, "app", "note.txt"), "utf8").catch(() => null), null)
  assert.deepEqual((await readLedger(context)).appliedMigrations, [])
})

test("full mode applies the migration and takes requiresPodRecreate only from it", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")
  await provisionWorkspace(context, summaryFor(context))
  const quiet = await writeMigration(roots, "app-builder", "0001-quiet", {
    operations: [{ type: "copy", source: "note.txt", target: "app/quiet.txt" }],
  })
  await writeFile(path.join(quiet, "note.txt"), "quiet\n")

  const first = await reconcileContent(context, summaryFor(context), { withMigrations: true })
  assert.deepEqual(first.appliedMigrations, ["0001-quiet"])
  assert.equal(first.requiresPodRecreate, false)

  const loud = await writeMigration(roots, "app-builder", "0002-loud", {
    requiresPodRecreate: true,
    operations: [{ type: "copy", source: "note.txt", target: "app/loud.txt" }],
  })
  await writeFile(path.join(loud, "note.txt"), "loud\n")

  const second = await reconcileContent(context, summaryFor(context), { withMigrations: true })
  assert.deepEqual(second.appliedMigrations, ["0002-loud"])
  assert.deepEqual(second.skippedMigrations, ["0001-quiet"])
  assert.equal(second.requiresPodRecreate, true)
  assert.deepEqual((await readLedger(context)).appliedMigrations, ["0001-quiet", "0002-loud"])
})

test("the result reports the owned skills written and removed and whether the config changed", async (t) => {
  const roots = await makeRoots()
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "app-builder")

  const first = await provisionWorkspace(context, summaryFor(context))
  assert.deepEqual(first.ownedSkills, { written: ["charts", "ui"], removed: [] })
  assert.equal(first.configChanged, true)

  const unchanged = await reconcileContent(context, summaryFor(context))
  assert.deepEqual(unchanged.ownedSkills, { written: ["charts", "ui"], removed: [] })
  assert.equal(unchanged.configChanged, false)

  await rm(path.join(roots.agentsRoot, "app-builder", "skills", "charts"), { recursive: true, force: true })
  const dropped = await reconcileContent(context, summaryFor(context))
  assert.deepEqual(dropped.ownedSkills, { written: ["ui"], removed: ["charts"] })
})

test("a custom package skips a colliding skill it does not own and never adopts it", async (t) => {
  const roots = await makeRoots({ packages: ["custom"], skills: { custom: ["charts"] } })
  t.after(() => rm(roots.root, { recursive: true, force: true }))
  const context = contextFor(roots, "custom")
  await provisionWorkspace(context, summaryFor(context))

  // The snapshot the Project was created with, written by the backend after first boot.
  await writeFile(path.join(context.skillsDir, "charts", "SKILL.md"), "# snapshot wins\n")
  await mkdir(path.join(context.skillsDir, "acme"), { recursive: true })
  await writeFile(path.join(context.skillsDir, "acme", "SKILL.md"), "# acme\n")
  const ledger = await readLedger(context)
  await writeFile(context.ledgerPath, JSON.stringify({ ...ledger, ownedSkills: [] }))
  await writeFile(path.join(roots.agentsRoot, "custom", "skills", "charts", "SKILL.md"), "# image v2\n")

  const summary = await reconcileContent(context, summaryFor(context))

  assert.deepEqual(summary.skippedSkills, ["charts"])
  assert.deepEqual(summary.ownedSkills, { written: [], removed: [] })
  assert.equal(await readFile(path.join(context.skillsDir, "charts", "SKILL.md"), "utf8"), "# snapshot wins\n")
  assert.equal(await readFile(path.join(context.skillsDir, "acme", "SKILL.md"), "utf8"), "# acme\n")
  assert.deepEqual((await readLedger(context)).ownedSkills, [])
})
