import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { after, before, describe } from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(here, "..", "agents", "skill-agent-builder")
const apiScript = path.join(packageRoot, "template", "scripts", "api.sh")
const checkTemplateScript = path.join(packageRoot, "template", "scripts", "check-template.sh")
const evidenceScript = path.join(packageRoot, "template", "scripts", "evidence.sh")
const turnScript = path.join(packageRoot, "template", "scripts", "turn.sh")
const snapshotScript = path.join(packageRoot, "template", "scripts", "template-snapshot.sh")
const posixShell = spawnSync("dash", ["-c", "exit 0"]).status === 0 ? "dash" : "sh"
const testProjectScript = path.join(packageRoot, "template", "scripts", "tp.sh")
const checkExpectationsScript = path.join(packageRoot, "template", "scripts", "check-expectations.mjs")

function runScript(command, args, options = {}) {
  const child = spawn(command, args, { ...options, env: { ...process.env, ...options.env } })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })))
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function outlives(pid, milliseconds) {
  for (const deadline = Date.now() + milliseconds; Date.now() < deadline; ) {
    if (!isAlive(pid)) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return isAlive(pid)
}

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
        if (request.url.endsWith("/hang")) return
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

  after(() => {
    server.closeAllConnections()
    server.close()
  })

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

  test("gives up on a request that outlives API_MAX_TIME", async () => {
    const started = Date.now()
    const result = await run(["runtime", "/api/proxy/env-1", "GET", "/hang"], { API_MAX_TIME: "1" })

    assert.notEqual(result.status, 0)
    assert.ok(Date.now() - started < 5000, "the request should be cut off after a second")
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

describe("check-template.sh", () => {
  const workspaces = []

  after(() => {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true })
  })

  function workspaceWith(files) {
    const workspace = mkdtempSync(path.join(tmpdir(), "check-template-"))
    workspaces.push(workspace)
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(workspace, "template", relative)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, content)
      if (relative.endsWith(".sh")) chmodSync(absolute, 0o755)
    }
    return workspace
  }

  function check(workspace, ...args) {
    return runScript("sh", [checkTemplateScript, ...args], {
      cwd: workspace,
      env: { CHECK_TEMPLATE_TIMEOUT: "30", OPSIFORCE_ENV: "production" },
    })
  }

  const servingStartup = [
    "#!/bin/bash",
    'cd "$(dirname "$0")"',
    "[ \"$OPSIFORCE_ENV\" = production ] && exit 9",
    "guard helper sh -c 'echo $$ > helper.pid; exec sleep 600' &",
    "guard server node -e 'require(\"fs\").writeFileSync(\"server.pid\", String(process.pid)); require(\"http\").createServer((q, s) => s.end(\"ok\")).listen(process.env.APP_PORT)' &",
    "wait",
    "",
  ].join("\n")

  test("boots a tiny Template in development on a spare port and reports success", async () => {
    const workspace = workspaceWith({ "app/startup.sh": servingStartup, "app/package.json": "{}" })

    const result = await check(workspace, "touch app/installed")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /PASS: answered HTTP 200 on port \d+/)
    const copy = path.join(workspace, ".cache", "template-check", "app")
    assert.ok(readdirSync(copy).includes("installed"), "the setup runs in the copy")
    assert.ok(!readdirSync(path.join(workspace, "template", "app")).includes("installed"), "template/ is never written")
  })

  test("leaves no process behind", async () => {
    const workspace = workspaceWith({ "app/startup.sh": servingStartup })

    const result = await check(workspace)

    assert.equal(result.status, 0, result.stdout + result.stderr)
    const copy = path.join(workspace, ".cache", "template-check", "app")
    for (const name of ["server.pid", "helper.pid"]) {
      const pid = Number(readFileSync(path.join(copy, name), "utf8"))
      assert.equal(await outlives(pid, 2000), false, `${name} (${pid}) is still running`)
    }
  })

  test("keeps what the setup installed and drops files the Template no longer has", async () => {
    const workspace = workspaceWith({ "app/startup.sh": servingStartup, "app/old.txt": "old" })
    await check(workspace, "mkdir -p app/node_modules && touch app/node_modules/kept")
    rmSync(path.join(workspace, "template", "app", "old.txt"))

    const result = await check(workspace)

    assert.equal(result.status, 0, result.stdout + result.stderr)
    const copy = path.join(workspace, ".cache", "template-check", "app")
    assert.ok(readdirSync(path.join(copy, "node_modules")).includes("kept"))
    assert.ok(!readdirSync(copy).includes("old.txt"))
  })

  test("fails on a broken Template with the log tail", async () => {
    const workspace = workspaceWith({
      "app/startup.sh": "#!/bin/bash\necho 'Error: Cannot find module ./server.js' >&2\nexit 3\n",
    })

    const result = await check(workspace)

    assert.equal(result.status, 1)
    assert.match(result.stdout, /FAIL: app\/startup.sh exited \(3\)/)
    assert.match(result.stdout, /last 40 lines[\s\S]*Cannot find module \.\/server\.js/)
  })

  test("fails when the setup fails, with its output", async () => {
    const workspace = workspaceWith({ "app/startup.sh": servingStartup })

    const result = await check(workspace, "echo 'lockfile out of date'; exit 4")

    assert.equal(result.status, 1)
    assert.match(result.stdout, /FAIL: the setup exited 4[\s\S]*lockfile out of date/)
  })

  test("runs the setup and reports nothing to boot when there is no startup.sh", async () => {
    const workspace = workspaceWith({ "package.json": "{}", "analyse.mjs": "console.log(1)\n" })

    const result = await check(workspace, "node analyse.mjs > ran.txt")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /nothing to boot/)
    assert.ok(readdirSync(path.join(workspace, ".cache", "template-check")).includes("ran.txt"))
  })

  test("runs a setup that ensures what it installs twice, changing nothing the second time", async () => {
    const workspace = workspaceWith({ "analyse.mjs": "console.log(1)\n" })
    const ensure = "[ -d .venv ] || { mkdir .venv && echo installed >> .venv/log; }"

    const first = await check(workspace, ensure)
    const second = await check(workspace, ensure)

    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.equal(second.status, 0, second.stdout + second.stderr)
    const installLog = readFileSync(path.join(workspace, ".cache", "template-check", ".venv", "log"), "utf8")
    assert.equal(installLog, "installed\n")
  })

  test("--production fails a Template whose production branch breaks, which development passes", async () => {
    const workspace = workspaceWith({ "app/startup.sh": servingStartup })

    const development = await check(workspace)
    const production = await check(workspace, "--production")

    assert.equal(development.status, 0, development.stdout + development.stderr)
    assert.equal(production.status, 1, production.stdout + production.stderr)
    assert.match(production.stdout, /booting app\/startup.sh in production/)
    assert.match(production.stdout, /FAIL: app\/startup.sh exited \(9\)/)
  })

  test("--production boots a fresh copy of only what git would track, under OPSIFORCE_ENV=production", async () => {
    const productionStartup = [
      "#!/bin/bash",
      'cd "$(dirname "$0")"',
      '[ "$OPSIFORCE_ENV" = production ] || exit 7',
      "[ -e built/leftover ] && exit 8",
      "[ -e installed ] && exit 6",
      "exec node -e 'require(\"http\").createServer((q, s) => s.end(\"ok\")).listen(process.env.APP_PORT)'",
      "",
    ].join("\n")
    const workspace = workspaceWith({
      "app/startup.sh": productionStartup,
      "app/.gitignore": "built/\n",
      "app/built/leftover": "from a development build",
    })
    await check(workspace, "touch app/installed")

    const result = await check(workspace, "--production")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /PASS: answered HTTP 200/)
    assert.ok(!readdirSync(path.join(workspace, ".cache", "template-check-production", "app")).includes("built"))
  })

  test("--production takes no setup, since Publish runs none", async () => {
    const workspace = workspaceWith({ "app/startup.sh": servingStartup })

    const result = await check(workspace, "--production", "touch app/installed")

    assert.equal(result.status, 2)
    assert.match(result.stderr, /takes none/)
  })
})

describe("template-snapshot.sh", () => {
  const workspaces = []

  after(() => {
    for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true })
  })

  function workspaceWith(files) {
    const workspace = mkdtempSync(path.join(tmpdir(), "template-snapshot-"))
    workspaces.push(workspace)
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(workspace, "template", relative)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, content)
    }
    return workspace
  }

  function snapshot(workspace, ...args) {
    return runScript(posixShell, [snapshotScript, ...args], { cwd: workspace })
  }

  test("has nothing to compare before the first save", async () => {
    const workspace = workspaceWith({ "app/page.tsx": "page" })

    const result = await snapshot(workspace, "diff")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /no snapshot yet/)
  })

  test("reports no difference right after a save", async () => {
    const workspace = workspaceWith({ "app/page.tsx": "page", "reference/brief.md": "brief" })

    const saved = await snapshot(workspace, "save")
    const result = await snapshot(workspace, "diff")

    assert.equal(saved.status, 0, saved.stdout + saved.stderr)
    assert.match(saved.stdout, /saved 2 files/)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /matches the last save/)
  })

  test("lists each file the author added, changed or deleted since the save, and exits 1", async () => {
    const workspace = workspaceWith({ "app/page.tsx": "page", "app/schema.ts": "sku", "app/old.ts": "old" })
    await snapshot(workspace, "save")
    writeFileSync(path.join(workspace, "template", "app", "schema.ts"), "no sku")
    writeFileSync(path.join(workspace, "template", "app", "reports.tsx"), "reports")
    rmSync(path.join(workspace, "template", "app", "old.ts"))

    const result = await snapshot(workspace, "diff")

    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.deepEqual(result.stdout.trim().split("\n"), ["D app/old.ts", "A app/reports.tsx", "M app/schema.ts"])
  })

  test("ignores what a save leaves out anyway, such as installed dependencies", async () => {
    const workspace = workspaceWith({ "app/page.tsx": "page" })
    await snapshot(workspace, "save")
    mkdirSync(path.join(workspace, "template", "app", "node_modules"), { recursive: true })
    writeFileSync(path.join(workspace, "template", "app", "node_modules", "dep.js"), "dep")

    const result = await snapshot(workspace, "diff")

    assert.equal(result.status, 0, result.stdout + result.stderr)
  })

  test("restores a changed file, removes an added one, and brings back a deleted one", async () => {
    const workspace = workspaceWith({ "app/schema.ts": "sku", "app/old.ts": "old" })
    await snapshot(workspace, "save")
    writeFileSync(path.join(workspace, "template", "app", "schema.ts"), "no sku")
    writeFileSync(path.join(workspace, "template", "app", "reports.tsx"), "reports")
    rmSync(path.join(workspace, "template", "app", "old.ts"))

    const restored = await snapshot(workspace, "restore", "app/schema.ts", "template/app/reports.tsx", "app/old.ts")
    const result = await snapshot(workspace, "diff")

    assert.equal(restored.status, 0, restored.stdout + restored.stderr)
    assert.equal(readFileSync(path.join(workspace, "template", "app", "schema.ts"), "utf8"), "sku")
    assert.equal(result.status, 0, result.stdout + result.stderr)
  })

  test("refuses a path outside template/", async () => {
    const workspace = workspaceWith({ "app/page.tsx": "page" })
    await snapshot(workspace, "save")

    const result = await snapshot(workspace, "restore", "../scratch/prompt.md")

    assert.equal(result.status, 1)
    assert.match(result.stdout, /refusing/)
  })

  test("refuses an unknown command instead of guessing", async () => {
    const workspace = workspaceWith({ "app/page.tsx": "page" })

    const result = await snapshot(workspace, "reset")

    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage/)
  })
})

describe("evidence.sh", () => {
  let server
  let origin
  let workspace
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

  const shell = (id, command, output, exit) => ({
    type: "tool",
    id,
    name: "shell",
    state: { status: "completed", input: { command }, content: [{ type: "text", text: output }], metadata: { exit } },
    time: { created: 1 },
  })
  const question = (id, status, text, labels, answers) => ({
    type: "tool",
    id,
    name: "question",
    state: {
      status,
      input: { questions: [{ header: "Choose", question: text, options: labels.map((label) => ({ label })) }] },
      metadata: answers ? { answers } : {},
      ...(status === "completed" ? { content: [{ type: "text", text: "User has answered your questions" }] } : {}),
    },
    time: { created: 4 },
  })
  const assistant = (id, content) => ({ id, type: "assistant", agent: "child", content, time: { created: 1 } })
  const timeline = [
    { id: "msg_a", type: "user", text: "first", time: { created: 1 } },
    assistant("msg_b", [shell("t1", "echo before", "before", 0)]),
    { id: "msg_prompt", type: "user", text: "Add a total row", time: { created: 2 } },
    assistant("msg_c", [
      { type: "text", text: "All checks passed." },
      shell("t2", "yarn test", "3 passing", 0),
      { type: "tool", id: "t3", name: "edit", state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "ok" }] }, time: { created: 3 } },
    ]),
    assistant("msg_d", [
      shell("t4", "curl -s localhost:3000/api/total", "curl: (7) refused", 7),
      question("t5", "completed", "Which total should the row show?", ["Sum", "Average"], [["Sum"]]),
    ]),
    assistant("msg_e", [question("t6", "running", "Keep the old column?", ["Keep", "Drop"])]),
  ]

  before(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "evidence-"))
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://x")
      const prefix = "/api/proxy/env-1"
      if (url.pathname === `${prefix}/api/session/ses_1/message`) {
        const newestFirst = [...timeline].reverse()
        const page = url.searchParams.get("cursor") === "older" ? newestFirst.slice(3) : newestFirst.slice(0, 3)
        const cursor = url.searchParams.get("cursor") === "older" ? {} : { next: "older" }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: page, cursor }))
      } else if (url.pathname === `${prefix}/api/fs/list`) {
        assert.equal(url.searchParams.get("path"), "/workspace/.cache/checks")
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ location: {}, data: [{ path: ".cache/checks/total row.png", type: "file" }] }))
      } else if (url.pathname === `${prefix}/api/fs/read/.cache/checks/total%20row.png`) {
        response.writeHead(200, { "content-type": "image/png" })
        response.end(png)
      } else {
        response.writeHead(404)
        response.end("{}")
      }
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(() => {
    server.close()
    rmSync(workspace, { recursive: true, force: true })
  })

  function evidence(args) {
    return runScript("sh", [evidenceScript, ...args], {
      cwd: workspace,
      env: { OPSIFORCE_API_URL: `${origin}/api/v1`, OPSIFORCE_RUNTIME_PROXY_URL: origin, OPSIFORCE_API_KEY: "gw-test" },
    })
  }

  test("lists the commands the child ran after the prompt, oldest first, with exit codes and output", async () => {
    const result = await evidence(["/api/proxy/env-1", "ses_1", "msg_prompt"])

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stdout, /echo before/)
    assert.doesNotMatch(result.stdout, /All checks passed/)
    assert.match(result.stdout, /## 1\. exit 0\n\$ yarn test\n3 passing/)
    assert.match(result.stdout, /## 2\. exit 7\n\$ curl -s localhost:3000\/api\/total\ncurl: \(7\) refused/)
  })

  test("lists each question the child asked, with its options and the answer or that it is still open", async () => {
    const result = await evidence(["/api/proxy/env-1", "ses_1", "msg_prompt"])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /## 3\. question \(answered\)\n\? Which total should the row show\?  \[Sum \| Average\]\n= Sum/)
    assert.match(result.stdout, /## 4\. question \(open\)\n\? Keep the old column\?  \[Keep \| Drop\](\n\n|$)/)
  })

  test("copies the child's screenshots into scratch/shots/", async () => {
    await evidence(["/api/proxy/env-1", "ses_1", "msg_prompt"])

    assert.deepEqual(readFileSync(path.join(workspace, "scratch", "shots", "child-total row.png")), png)
  })

  test("refuses a message id the session does not have", async () => {
    const result = await evidence(["/api/proxy/env-1", "ses_1", "msg_missing"])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no message msg_missing/)
  })
})

describe("turn.sh", () => {
  let server
  let origin
  const prefix = "/api/proxy/env-1"
  const running = new Set(["ses_busy", "ses_asking"])
  const openForms = new Map([
    [
      "ses_asking",
      {
        id: "frm_1",
        sessionID: "ses_asking",
        title: "Questions",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            title: "Choose version",
            description: "Which file should I update?",
            type: "string",
            options: [
              { value: "Update the draft (Recommended)", label: "Update the draft (Recommended)" },
              { value: "Update the original", label: "Update the original" },
            ],
            custom: true,
          },
        ],
      },
    ],
  ])
  const replies = []
  const lastAssistant = new Map([
    ["ses_broken", { finish: "error", error: { name: "ProviderError", message: "the model provider hung up" } }],
    ["ses_cut", { finish: "tool-calls" }],
  ])

  before(async () => {
    server = createServer((request, response) => {
      const chunks = []
      request.on("data", (chunk) => chunks.push(chunk))
      request.on("end", () => {
        const url = new URL(request.url, "http://x")
        const send = (status, body) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(body === undefined ? "" : JSON.stringify(body))
        }
        if (!url.pathname.startsWith(prefix)) return send(404, {})
        const route = url.pathname.slice(prefix.length)
        if (route === "/api/session/active") {
          if (running.has("ses_hanging")) return
          return send(200, { data: Object.fromEntries([...running].map((id) => [id, { type: "running" }])) })
        }
        const reply = route.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/)
        if (reply && request.method === "POST") {
          const [, session, formID] = reply
          if (openForms.get(session)?.id !== formID) return send(409, { name: "FormAlreadySettledError" })
          replies.push({ session, formID, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
          openForms.delete(session)
          running.delete(session)
          return send(204)
        }
        const messages = route.match(/^\/api\/session\/([^/]+)\/message$/)
        if (messages) {
          const last = lastAssistant.get(messages[1]) ?? { finish: "stop" }
          return send(200, {
            data: [
              { id: "msg_2", type: "assistant", content: [], ...last },
              { id: "msg_1", type: "user", text: "hi" },
            ],
          })
        }
        const forms = route.match(/^\/api\/session\/([^/]+)\/form$/)
        if (forms) return send(200, { data: openForms.has(forms[1]) ? [openForms.get(forms[1])] : [] })
        const session = route.match(/^\/api\/session\/(ses_[^/]+)$/)
        if (session && session[1] !== "ses_missing") return send(200, { data: { id: session[1] } })
        return send(404, { name: "SessionNotFoundError" })
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(() => {
    server.closeAllConnections()
    server.close()
  })

  const env = (extra = {}) => ({
    OPSIFORCE_API_URL: `${origin}/api/v1`,
    OPSIFORCE_RUNTIME_PROXY_URL: origin,
    OPSIFORCE_API_KEY: "gw-test",
    TURN_POLL: "1",
    ...extra,
  })
  const turn = (session, extra) => runScript(posixShell, [turnScript, prefix, session], { env: env(extra) })
  const api = (args) => runScript("sh", [apiScript, ...args], { env: env() })

  test("returns 0 once the Session is idle on a finished turn", async () => {
    const result = await turn("ses_idle")

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "idle finish=stop")
  })

  test("returns 5 when the Session went idle on a turn that broke off, with its error", async () => {
    const broken = await turn("ses_broken")

    assert.equal(broken.status, 5, broken.stderr)
    assert.match(broken.stdout, /^idle finish=error$/m)
    assert.match(broken.stdout, /^error: the model provider hung up$/m)

    const cut = await turn("ses_cut")
    assert.equal(cut.status, 5, cut.stderr)
    assert.equal(cut.stdout.trim(), "idle finish=tool-calls")
  })

  test("stops at an open Form and prints what answering it needs", async () => {
    const result = await turn("ses_asking")

    assert.equal(result.status, 3, result.stderr)
    assert.match(result.stdout, /^form frm_1: Questions$/m)
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf("[")))
    assert.deepEqual(printed, [
      {
        id: "frm_1",
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Choose version",
            description: "Which file should I update?",
            options: ["Update the draft (Recommended)", "Update the original"],
            custom: true,
          },
        ],
      },
    ])
  })

  test("the turn goes on once the Form is answered the way the recipe sends it", async () => {
    const answered = await api([
      "runtime",
      prefix,
      "POST",
      "/api/session/ses_asking/form/frm_1/reply",
      '{"answer":{"q0":"Update the original"}}',
    ])

    assert.equal(answered.status, 0, answered.stderr)
    assert.deepEqual(replies.at(-1), {
      session: "ses_asking",
      formID: "frm_1",
      body: { answer: { q0: "Update the original" } },
    })
    const result = await turn("ses_asking")
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "idle finish=stop")
  })

  test("reports a turn still running at the deadline with its own exit code", async () => {
    const started = Date.now()
    const result = await turn("ses_busy", { TURN_TIMEOUT: "2" })

    assert.equal(result.status, 4, result.stderr)
    assert.match(result.stdout, /^timeout: the turn is still running after \d+ s$/m)
    assert.ok(Date.now() - started < 10000)
  })

  test("still meets its deadline when the runtime stops answering", async () => {
    running.add("ses_hanging")
    try {
      const started = Date.now()
      const result = await turn("ses_hanging", { TURN_TIMEOUT: "2", API_MAX_TIME: "1" })

      assert.equal(result.status, 4, result.stderr)
      assert.match(result.stdout, /^timeout:/m)
      assert.ok(Date.now() - started < 10000)
    } finally {
      running.delete("ses_hanging")
    }
  })

  test("refuses a session the runtime does not have", async () => {
    const result = await turn("ses_missing")

    assert.equal(result.status, 1)
    assert.match(result.stderr, /no session ses_missing/)
  })
})

describe("tp.sh", () => {
  let server
  let origin
  const prefix = "/api/proxy/env-1"
  const calls = []
  let world

  const freshWorld = (overrides = {}) => ({
    subject: { type: "agent", id: "agent-1" },
    testProject: null,
    exists: false,
    createAnswer: null,
    statuses: ["starting", "active"],
    disabled: false,
    connectRefusals: 1,
    sessions: ["ses_1", "ses_2"],
    boundSession: null,
    forms: [],
    shells: new Map(),
    child: null,
    ...overrides,
  })

  function runShell(command) {
    if (command === "hostname -i") return { output: "10.1.2.3 fe80::1\n", exit: 0 }
    const ran = spawnSync("sh", ["-c", command.replaceAll("/workspace", world.child)], {
      encoding: "utf8",
      env: { ...process.env, APP_PORT: "4321" },
    })
    return { output: ran.stdout + ran.stderr, exit: ran.status }
  }

  before(async () => {
    server = createServer((request, response) => {
      const chunks = []
      request.on("data", (chunk) => chunks.push(chunk))
      request.on("end", () => {
        const url = new URL(request.url, "http://x")
        const body = Buffer.concat(chunks).toString("utf8")
        calls.push({ method: request.method, path: url.pathname, query: url.search, body })
        const send = (status, payload) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(payload === undefined ? "" : JSON.stringify(payload))
        }
        const route = `${request.method} ${url.pathname}`
        if (route === "GET /api/v1/me") {
          return send(200, {
            builderSubject: world.subject,
            builderTestProject: world.testProject ? { id: world.testProject } : null,
          })
        }
        if (route === "POST /api/v1/projects") {
          if (world.createAnswer) return send(...world.createAnswer)
          world.exists = true
          return send(201, { id: "tp-1" })
        }
        const project = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(\/.*)?$/)
        if (project) {
          const [, id, rest = ""] = project
          if (!world.exists || id !== "tp-1") return send(404, { code: "project-not-found" })
          if (request.method === "GET" && rest === "") {
            const status = world.statuses.length > 1 ? world.statuses.shift() : world.statuses[0]
            return send(200, { id, disabled: world.disabled, environments: [{ id: "env-1", status }] })
          }
          if (request.method === "POST" && rest === "/restart") {
            world.statuses = world.afterRestart ?? ["active"]
            return send(204)
          }
          if (request.method === "POST" && rest === "/test/update") return send(204)
          if (request.method === "POST" && rest === "/test/reset") {
            world.boundSession = null
            world.sessions.shift()
            return send(204)
          }
          if (request.method === "POST" && rest === "/environments/env-1/connect") {
            if (world.connectRefusals > 0) {
              world.connectRefusals -= 1
              return send(503, { code: "environment-starting" })
            }
            world.boundSession ??= world.sessions[0]
            return send(200, { baseUrl: prefix, openapiUrl: `${prefix}/openapi.json`, sessionId: world.boundSession })
          }
          return send(404, {})
        }
        if (!url.pathname.startsWith(prefix)) return send(404, {})
        const runtime = `${request.method} ${url.pathname.slice(prefix.length)}`
        if (runtime === "GET /api/session/active") return send(200, { data: {} })
        let match
        if ((match = runtime.match(/^GET \/api\/session\/([^/]+)$/))) return send(200, { data: { id: match[1] } })
        if ((match = runtime.match(/^POST \/api\/session\/([^/]+)\/prompt$/))) return send(200, { data: { id: JSON.parse(body).id } })
        if ((match = runtime.match(/^GET \/api\/session\/([^/]+)\/message$/))) {
          const prompted = calls.findLast((call) => call.path.endsWith("/prompt"))
          const id = prompted ? JSON.parse(prompted.body).id : "msg_0"
          return send(200, {
            data: [
              { id: "msg_z", type: "assistant", finish: "stop", content: [] },
              { id, type: "user", text: "hi" },
            ],
            cursor: {},
          })
        }
        if ((match = runtime.match(/^GET \/api\/session\/([^/]+)\/form$/))) return send(200, { data: world.forms })
        if ((match = runtime.match(/^POST \/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/))) {
          world.forms = []
          return send(204)
        }
        if (runtime === "POST /api/session/ses_1/interrupt") return send(200, { data: true })
        if (runtime === "GET /api/fs/list") return send(200, { data: [] })
        if (runtime === "POST /api/shell") {
          const id = `sh_${world.shells.size + 1}`
          const { command, timeout } = JSON.parse(body)
          world.shells.set(id, { ...runShell(command), timeout })
          return send(200, { data: { id, status: "running" } })
        }
        if ((match = runtime.match(/^GET \/api\/shell\/([^/]+)$/))) {
          return send(200, { data: { id: match[1], status: "exited", exit: world.shells.get(match[1]).exit } })
        }
        if ((match = runtime.match(/^GET \/api\/shell\/([^/]+)\/output$/))) {
          const { output } = world.shells.get(match[1])
          const cursor = Number(url.searchParams.get("cursor") ?? 0)
          const page = output.slice(cursor, cursor + 8)
          return send(200, { data: { output: page, cursor: cursor + page.length, size: output.length } })
        }
        return send(404, { name: "NotFoundError" })
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(() => {
    server.closeAllConnections()
    server.close()
  })

  function workspace(files = { "app/startup.sh": "#!/bin/sh\n", "app/README.md": "one\n" }) {
    const root = mkdtempSync(path.join(tmpdir(), "tp-"))
    for (const [relative, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, "template", relative)), { recursive: true })
      writeFileSync(path.join(root, "template", relative), content)
    }
    mkdirSync(path.join(root, "scratch"))
    return root
  }

  const tp = (root, ...args) =>
    runScript(posixShell, [testProjectScript, ...args], {
      cwd: root,
      env: {
        OPSIFORCE_API_URL: `${origin}/api/v1`,
        OPSIFORCE_RUNTIME_PROXY_URL: origin,
        OPSIFORCE_API_KEY: "gw-test",
        TP_POLL: "0",
        TP_ATTEMPTS: "5",
        TURN_POLL: "1",
      },
    })
  const stateOf = (root) => JSON.parse(readFileSync(path.join(root, "scratch", "test-project.json"), "utf8"))
  const created = () => calls.filter((call) => call.method === "POST" && call.path === "/api/v1/projects")

  test("up creates the Test Project once, waits, connects through a 503 and records everything", async () => {
    world = freshWorld()
    calls.length = 0
    const root = workspace()

    const result = await tp(root, "up")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.deepEqual(JSON.parse(created()[0].body), { agentId: "agent-1", title: "Test run", kind: "test" })
    assert.match(result.stdout, /^session ses_1$/m)
    assert.match(result.stdout, /^openapi \/api\/proxy\/env-1\/openapi\.json$/m)
    const state = stateOf(root)
    assert.equal(state.projectId, "tp-1")
    assert.equal(state.agentId, "agent-1")
    assert.equal(state.environmentId, "env-1")
    assert.equal(state.baseUrl, prefix)
    assert.equal(state.sessionId, "ses_1")

    const again = await tp(root, "up")
    assert.equal(again.status, 0, again.stdout + again.stderr)
    assert.equal(created().length, 1, "a second up reuses the recorded Project")
  })

  test("up recovers the Project from a create's 409 when nothing recorded it", async () => {
    world = freshWorld({ exists: true, createAnswer: [409, { code: "test-project-exists", testProjectId: "tp-1" }] })
    const root = workspace()

    const result = await tp(root, "up")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(stateOf(root).projectId, "tp-1")
  })

  test("up says so and exits 1 when the Test Project is disabled", async () => {
    world = freshWorld({ exists: true, testProject: "tp-1", disabled: true })
    const root = workspace()

    const result = await tp(root, "up")

    assert.equal(result.status, 1)
    assert.match(result.stdout, /^disabled: .*Test run pane's menu/m)
  })

  test("up retries a failed environment once through a restart, and stops on a second failure", async () => {
    world = freshWorld({ exists: true, testProject: "tp-1", statuses: ["failed"] })
    calls.length = 0
    const recovered = await tp(workspace(), "up")

    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr)
    assert.equal(calls.filter((call) => call.path.endsWith("/restart")).length, 1)

    world = freshWorld({ exists: true, testProject: "tp-1", statuses: ["failed"], afterRestart: ["failed"] })
    const failed = await tp(workspace(), "up")
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /failed twice: a pod fault/)
  })

  test("up refuses a Skill chat: a Test Project runs an Agent", async () => {
    world = freshWorld({ subject: { type: "skill", id: "skill-1" } })

    const result = await tp(workspace(), "up")

    assert.equal(result.status, 1)
    assert.match(result.stderr, /authors a skill/)
    assert.equal(created().length, 0)
  })

  test("prompt sends its own msg_ id, records it and waits for the turn; evidence reads from it", async () => {
    world = freshWorld()
    calls.length = 0
    const root = workspace()
    await tp(root, "up")

    const result = await tp(root, "prompt", 'Add a "total" row')

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /idle finish=stop/)
    const sent = JSON.parse(calls.find((call) => call.path.endsWith("/api/session/ses_1/prompt")).body)
    assert.equal(sent.text, 'Add a "total" row')
    assert.match(sent.id, /^msg_\d+$/)
    assert.equal(stateOf(root).lastMessageId, sent.id)

    const evidence = await tp(root, "evidence")
    assert.equal(evidence.status, 0, evidence.stderr)
    assert.match(evidence.stdout, new RegExp(`No commands recorded since ${sent.id}`))
  })

  test("answer replies to the open Form with the answer object, then waits", async () => {
    world = freshWorld()
    const root = workspace()
    await tp(root, "up")
    world.forms = [{ id: "frm_1", title: "Questions", fields: [] }]
    calls.length = 0

    const result = await tp(root, "answer", '{"q0":["A","B"]}')

    assert.equal(result.status, 0, result.stdout + result.stderr)
    const reply = calls.find((call) => call.path.endsWith("/form/frm_1/reply"))
    assert.deepEqual(JSON.parse(reply.body), { answer: { q0: ["A", "B"] } })
    assert.equal((await tp(root, "answer", "not json")).status, 1)
  })

  test("sh prints every page of a command's output, exits with its code and sends the timeout in ms", async () => {
    world = freshWorld()
    const root = workspace()
    world.child = mkdtempSync(path.join(tmpdir(), "tp-child-"))
    await tp(root, "up")

    const result = await tp(root, "sh", "printf 'a long line of output\\n'; exit 3")

    assert.equal(result.status, 3)
    assert.equal(result.stdout, "a long line of output\n")
    assert.equal([...world.shells.values()].at(-1).timeout, 60000)
    assert.equal((await tp(root, "app-url")).stdout.trim(), "http://10.1.2.3:4321")
  })

  test("touched prints only the files both the child and the save change, and each file the save drops", async () => {
    world = freshWorld()
    const root = workspace({ "app/a.txt": "a\n", "app/b.txt": "b\n", "app/c.txt": "c\n" })
    await tp(root, "up")
    const snapshot = await runScript(posixShell, [snapshotScript, "save"], { cwd: root })
    assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr)
    const child = mkdtempSync(path.join(tmpdir(), "tp-child-"))
    world.child = child
    const git = (...args) => spawnSync("git", ["-C", child, ...args], { encoding: "utf8" })
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "t")
    mkdirSync(path.join(child, "app"))
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(path.join(child, "app", name), `${name}\n`)
    git("add", ".")
    git("commit", "-q", "-m", "Initial template")
    writeFileSync(path.join(child, "app", "a.txt"), "the child's edit\n")
    writeFileSync(path.join(child, "app", "new.txt"), "the child's file\n")
    writeFileSync(path.join(root, "template", "app", "a.txt"), "the fix\n")
    writeFileSync(path.join(root, "template", "app", "d.txt"), "added by the fix\n")
    rmSync(path.join(root, "template", "app", "c.txt"))

    const result = await tp(root, "touched")

    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.stdout, "touched app/a.txt\ndropped app/c.txt: an update keeps it, so remove it through tp.sh sh\n")

    writeFileSync(path.join(child, "app", "a.txt"), "a.txt\n")
    assert.match((await tp(root, "touched")).stdout, /^untouched\n/)

    writeFileSync(path.join(child, "app", "b.txt"), "the child's other edit\n")
    rmSync(path.join(root, ".cache", "template-saved"), { recursive: true })
    const unknown = await tp(root, "touched")
    assert.match(unknown.stdout, /^no snapshot of the last save: every file in template\/ counts as changed$/m)
    assert.match(unknown.stdout, /^touched app\/b\.txt$/m)
  })

  test("update overlays in place; reset rebinds a new Session", async () => {
    world = freshWorld()
    const root = workspace()
    await tp(root, "up")
    calls.length = 0

    const updated = await tp(root, "update")

    assert.equal(updated.status, 0, updated.stdout + updated.stderr)
    assert.match(updated.stdout, /^updated: /m)
    assert.equal(calls.filter((call) => call.path.endsWith("/connect")).length, 0)

    const reset = await tp(root, "reset")
    assert.equal(reset.status, 0, reset.stdout + reset.stderr)
    assert.match(reset.stdout, /^session ses_2$/m)
    assert.equal(stateOf(root).sessionId, "ses_2")
    assert.equal(stateOf(root).lastMessageId, undefined)
  })

  test("renames an older chat's per-Agent expectations file to the fixed name", async () => {
    world = freshWorld()
    const root = workspace()
    writeFileSync(path.join(root, "scratch", "shop.expectations.md"), "## Prompts\n")

    const result = await tp(root, "up")

    assert.match(result.stdout, /renamed scratch\/shop\.expectations\.md to scratch\/expectations\.md/)
    assert.ok(existsSync(path.join(root, "scratch", "expectations.md")))
  })
})

describe("check-expectations.mjs", () => {
  const good = [
    "## Prompts",
    "1. Track my stock",
    "2. Rename the second column",
    "",
    "## Machine-checkable",
    "- the list page answers — `curl -s -o /dev/null -w '%{http_code}' localhost:$APP_PORT` → 200",
    "",
    "## Judgement",
    "- the empty state reads well",
    "",
    "## Fixes",
    "- R1 · the list page answers · template · the child installed a missing package · add it to the manifest · update",
    "- R1 · the empty state reads well · body · it wrote no empty state · state the empty state in Done looks like · update",
    "- R2 · the list page answers · skill · it followed the old build command · re-pin the stack Skill · reset",
    "",
  ].join("\n")

  function check(content) {
    const root = mkdtempSync(path.join(tmpdir(), "expectations-"))
    mkdirSync(path.join(root, "scratch"))
    if (content !== undefined) writeFileSync(path.join(root, "scratch", "expectations.md"), content)
    return spawnSync(process.execPath, [checkExpectationsScript], { cwd: root, encoding: "utf8" })
  }

  test("accepts a file in the shape and counts it", () => {
    const result = check(good)

    assert.equal(result.status, 0, result.stdout)
    assert.equal(result.stdout.trim(), "OK: 2 prompts, 1 machine-checkable, 1 judgement, 2 fixing rounds")
  })

  test("accepts `- none` under a Fixes section before any fixing round", () => {
    assert.equal(check(good.replace(/## Fixes[\s\S]*$/, "## Fixes\n- none\n")).status, 0)
  })

  test("names each offence with its line", () => {
    const bad = good
      .replace("1. Track my stock\n2. Rename the second column\n", "")
      .replace("→ 200", "is 200")
      .replace("· template · the child", "· slip · the child")
      .replace("· re-pin the stack Skill · reset", "· reset")
      .replace("state the empty state in Done looks like · update", "state the empty state in Done looks like · reset")

    const result = check(bad)

    assert.equal(result.status, 1)
    const lines = result.stdout.trim().split("\n")
    assert.ok(lines.some((line) => /## Prompts lists no prompt/.test(line)), result.stdout)
    assert.ok(lines.some((line) => /:4: a machine-checkable line ends in/.test(line)), result.stdout)
    assert.ok(lines.some((line) => /:10: whose failure is template, body or skill, not "slip"/.test(line)), result.stdout)
    assert.ok(lines.some((line) => /:11: R1 already refreshed by update/.test(line)), result.stdout)
    assert.ok(lines.some((line) => /:12: a fix has six fields/.test(line)), result.stdout)
  })

  test("wants every section and one list line per entry", () => {
    const result = check("## Prompts\n- one\nsome prose\n")

    assert.equal(result.status, 1)
    assert.match(result.stdout, /:3: one list line per entry under ## Prompts/)
    assert.match(result.stdout, /no ## Machine-checkable section/)
    assert.match(result.stdout, /no ## Fixes section/)
  })

  test("reports a missing file", () => {
    const result = check(undefined)

    assert.equal(result.status, 1)
    assert.match(result.stdout, /scratch\/expectations\.md: missing/)
  })
})
