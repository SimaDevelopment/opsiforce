import assert from "node:assert/strict"
import { accessSync, constants, readFileSync } from "node:fs"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { composeSkills } from "./compose-skills.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const opsiforceRoot = path.join(here, "..", "..")
const packageRoot = path.join(here, "..", "agents", "external-service-builder")
const app = path.join(packageRoot, "template", "app")

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

describe("the External Service Builder package", () => {
  it("is a Built-in Agent with no pool", () => {
    const entry = readJson(path.join(here, "..", "agents.json")).agents["external-service-builder"]

    assert.equal(entry.poolSize, 0)
    assert.equal(entry.default, false)
    assert.match(entry.version, /^\d+\.\d+\.\d+$/)
  })

  it("installs the SDK version this image packs, from the tarball vendored into the service", () => {
    const sdkVersion = readJson(path.join(opsiforceRoot, "external-service-sdk", "package.json")).version
    const manifest = readJson(path.join(app, "package.json"))

    assert.equal(
      manifest.dependencies["@opsiforce/external-service-sdk"],
      `file:./vendor/external-service-sdk-${sdkVersion}.tgz`,
    )
    assert.deepEqual(manifest.dependenciesMeta["@opsiforce/external-service-sdk"], { unplugged: true })
  })

  it("stays on Yarn Plug'n'Play", () => {
    assert.match(readFileSync(path.join(app, ".yarnrc.yml"), "utf8"), /^nodeLinker: pnp$/m)
  })

  it("starts with Development reloading and Production installing exactly what was committed", () => {
    const startup = readFileSync(path.join(app, "startup.sh"), "utf8")

    accessSync(path.join(app, "startup.sh"), constants.X_OK)
    assert.match(startup, /yarn install --immutable\n\s*guard service yarn serve &/)
    assert.match(startup, /guard service yarn dev &/)
    assert.match(startup, /\nwait -n\n$/)
  })

  it("ships the external-service-authoring skill its prompt loads, beside platform and sqlite", async () => {
    const outDir = path.join(await mkdtemp(path.join(tmpdir(), "external-service-builder-")), "skills")

    await composeSkills({
      packageName: "external-service-builder",
      sharedDir: path.join(here, "..", "skills"),
      overridesDir: path.join(packageRoot, "skills"),
      outDir,
    })

    assert.deepEqual((await readdir(outDir)).toSorted(), ["external-service-authoring", "platform", "sqlite"])
    assert.deepEqual((await readdir(path.join(outDir, "external-service-authoring", "references"))).toSorted(), [
      "handlers.md",
      "inbound.md",
      "manifest.md",
      "patterns.md",
      "review-stops.md",
      "routes.md",
      "service-skill.md",
      "testing.md",
    ])
    assert.match(readFileSync(path.join(packageRoot, "agent.md"), "utf8"), /`external-service-authoring`/)
  })

  it("lays an SDK 2 service with no routes, so everything starts not supported", () => {
    const manifest = readJson(path.join(app, "service.json"))
    const types = readFileSync(path.join(app, "service.types.ts"), "utf8")
    const service = readFileSync(path.join(app, "service.ts"), "utf8")

    assert.equal(manifest.sdk, 2)
    assert.match(types, /^export const manifestHash = '[0-9a-f]{64}';$/m)
    assert.match(service, /defineService<Manifest>\(\{\s*manifest,\s*routes: \[\],\s*\}\)/)
    assert.throws(() => accessSync(path.join(app, "handlers.ts")))
  })

  it("lays upstreams, groups, tests, the Service skill and a README", async () => {
    for (const file of ["src/upstreams.ts", "test/service.test.ts", "SKILL.md", "README.md"]) {
      accessSync(path.join(app, file))
    }
    assert.ok((await readdir(path.join(app, "src", "groups"))).length > 0)
    assert.ok((await readdir(path.join(app, "test", "groups"))).length > 0)
    assert.match(readFileSync(path.join(app, "test", "service.test.ts"), "utf8"), /testService\(service,/)
  })
})
