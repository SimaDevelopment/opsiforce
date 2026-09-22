import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import test, { after, before, describe } from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(here, "..", "agents", "skill-agent-builder")
const apiScript = path.join(packageRoot, "template", "scripts", "api.sh")

function markdownFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...markdownFiles(absolute))
    else if (entry.name.endsWith(".md")) found.push(absolute)
  }
  return found
}

describe("the shell recipes the Builder is told to run", () => {
  test("every sh block in the package parses", () => {
    const blocks = []
    for (const file of markdownFiles(packageRoot)) {
      const text = readFileSync(file, "utf8")
      for (const match of text.matchAll(/^```sh\n([\s\S]*?)^```/gm)) {
        blocks.push({ file: path.relative(packageRoot, file), script: match[1] })
      }
    }

    assert.ok(blocks.length >= 5, `expected several sh blocks, found ${blocks.length}`)
    for (const { file, script } of blocks) {
      const parsed = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" })
      assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`)
    }
  })
})

describe("api.sh", () => {
  let server
  let origin
  const seen = []

  before(async () => {
    server = createServer((request, response) => {
      const chunks = []
      request.on("data", (chunk) => chunks.push(chunk))
      request.on("end", () => {
        seen.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        })
        response.writeHead(201, { "content-type": "application/json" })
        response.end('{"id":"p_1"}')
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(() => server.close())

  function run(args, env = {}) {
    const child = spawn("sh", [apiScript, ...args], {
      env: {
        ...process.env,
        OPSIFORCE_API_URL: `${origin}/api/v1`,
        OPSIFORCE_RUNTIME_PROXY_URL: origin,
        OPSIFORCE_API_KEY: "gw-test",
        ...env,
      },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })))
  }

  test("sends a GET to the platform API with the bearer", async () => {
    const result = await run(["call", "GET", "/skills?filter=built_in"])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '{"id":"p_1"}')
    const last = seen.at(-1)
    assert.equal(last.method, "GET")
    assert.equal(last.url, "/api/v1/skills?filter=built_in")
    assert.equal(last.authorization, "Bearer gw-test")
  })

  test("sends an inline JSON body as JSON", async () => {
    await run(["call", "POST", "/projects", '{"title":"Test","kind":"test"}'])

    const last = seen.at(-1)
    assert.equal(last.method, "POST")
    assert.equal(last.url, "/api/v1/projects")
    assert.equal(last.contentType, "application/json")
    assert.deepEqual(JSON.parse(last.body), { title: "Test", kind: "test" })
  })

  test("sends a @file body from disk", async () => {
    await run(["call", "PUT", "/agents/a1/profile", `@${path.join(here, "..", "agent-image-version.json")}`])

    const last = seen.at(-1)
    assert.equal(last.method, "PUT")
    assert.ok(JSON.parse(last.body).version, "the file's contents should be the request body")
  })

  test("resolves a runtime baseUrl against the runtime proxy origin, not the platform API", async () => {
    await run(["runtime", "/api/proxy/env-1", "POST", "/api/session/ses_1/prompt", '{"text":"hi"}'])

    const last = seen.at(-1)
    assert.equal(last.url, "/api/proxy/env-1/api/session/ses_1/prompt")
    assert.equal(last.authorization, "Bearer gw-test")
    assert.deepEqual(JSON.parse(last.body), { text: "hi" })
  })

  test("prints the runtime proxy origin on its own, trailing slash dropped", async () => {
    assert.equal((await run(["origin"])).stdout, origin)
    assert.equal((await run(["origin"], { OPSIFORCE_RUNTIME_PROXY_URL: `${origin}/` })).stdout, origin)
  })

  test("refuses a runtime call in a pod with no runtime proxy origin", async () => {
    const result = await run(["runtime", "/api/proxy/env-1", "GET", "/api/session"], {
      OPSIFORCE_RUNTIME_PROXY_URL: "",
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OPSIFORCE_RUNTIME_PROXY_URL/)
  })

  test("prints a status code alone", async () => {
    assert.equal((await run(["status", "GET", "/me"])).stdout.trim(), "201")
  })

  test("refuses to run in a pod that holds no platform-api key", async () => {
    const result = await run(["call", "GET", "/me"], { OPSIFORCE_API_KEY: "" })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OPSIFORCE_API_KEY/)
  })

  test("refuses an unknown command instead of guessing", async () => {
    const result = await run(["publish", "GET", "/me"])

    assert.equal(result.status, 2)
    assert.match(result.stderr, /unknown command/)
  })
})
