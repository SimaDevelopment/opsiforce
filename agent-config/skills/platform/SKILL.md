---
name: platform
description: The Opsiforce platform contract every agent runs under — an App is `/workspace/app/startup.sh` serving on `$APP_PORT`, and it goes live the moment `app/app.meta.json` exists. Also covers what a pod restart wipes and what the workspace keeps, uploaded and generated files, `app/opsiforce.env.json` and Publish, the platform environment variables, the LLM gateway and the ban on local models, calling External Services and their errors, and the two read-only platform databases. Load it before building, serving, installing, or debugging anything.
---

# The Opsiforce platform

You run inside a per-project pod on the Opsiforce platform. Everything below is true of every project, whatever stack you build in.

## You do the work, and you install what it needs

The person in the chat talks to you; you are the one with the shell. Do the work yourself, and never ask them to run a command, edit a file or install something.

The container is a sandbox and you are root in it. Install whatever a task needs without asking — `apt-get install -y`, `pip install` (with `--break-system-packages` when PEP 668 refuses), `npm install -g` — and never refuse a task because a tool is missing. §The pod is disposable, the workspace is durable says which installs survive a restart: once the App depends on one, it moves into `startup.sh`.

## The App contract

An **App** is three things. Satisfy them and the platform routes to it, shows a preview pane, reports it live, and publishes it. Miss one and nothing appears.

1. **`/workspace/app/startup.sh`** — an executable shell script that starts your server in the foreground. The platform runs it, restarts it when it exits, and runs it again in the published environment. Never start a server any other way: a process you launch yourself is not supervised and dies with your shell. Anything else the App needs installed or running comes from this same script too — see the next section.
2. **It serves HTTP on `$APP_PORT`.** Read the port from the environment — never hardcode it. Any HTTP answer on that port, at any status, counts as serving; the platform does not require a health route.
3. **`/workspace/app/app.meta.json`** — `{"name": "…", "description": "…"}` and nothing else. Writing this file is **go-live**: it makes the preview pane appear and the public link work. Write it as soon as the first feature works, not at the end.

```bash
chmod +x /workspace/app/startup.sh
```

Until `startup.sh` exists the pod idles quietly — there is no penalty for a workspace with no App yet.

If `app.meta.json` already exists, leave its `name` and `description` alone. Users edit them from the platform and their edits must survive your changes; rewrite them only when the user asks to rename the App.

The App's public address is in `APP_PUBLIC_URL`. Share that link once, when you first create `app.meta.json` — never the `localhost` address, and never again on later edits.

**One Project is one App.** A project holds exactly one App and one conversation. If the user wants a different App, they start a new project.

## The pod is disposable, the workspace is durable

`/workspace` is the project's own volume and survives everything. The container around it is the image plus whatever this session installed, and it is thrown away whenever the pod is recreated: the project stops or idles out and is resumed, the agent image is updated, or the App is published.

Gone with the container, every time:

- `apt-get install`, `pip install` into the system site-packages, `npm install -g`
- files you wrote outside `/workspace` — in `/root`, `/tmp`, `/opt`, `/usr/local`. What the image itself ships there (Node, Yarn, Python, `guard`, its CLIs) is back on every boot; never reinstall or re-enable it from `startup.sh`
- exported environment variables, shell aliases, cron entries — recurring work is a platform schedule, not a crontab
- every process you started by hand

`startup.sh` is the only thing that runs again: on every fresh container, again in the same container whenever it exits, and in every published Environment from a fresh checkout. It is therefore the complete, repeatable recipe for bringing the App up from nothing, and everything in it follows from that.

- **Ensure, never assume.** Anything the App needs at runtime that is not a file under `/workspace/app` — a system package, a language runtime, a tool, a service — is installed from `startup.sh`, **idempotently**: check whether it is there, install only when it is not. Every line must succeed both on a bare container and on one where the script already ran.
- **Prefer what lives in the workspace.** A toolchain the image lacks is downloaded once into `/workspace/.cache/<tool>-<version>`, which git ignores and every restart keeps; the App's own packages and environment live under `app/`. Either is paid once; a system install is paid on every boot, and in production on every deploy. Anything installed or built under `app/` is listed in `app/.gitignore`, because Publish commits everything git does not ignore.
- **Work with no App follows the same rules.** Without `startup.sh` nothing runs again after a restart, so a script that needs something the image lacks ensures it into `/workspace` before it runs.
- **State lives under `/workspace/app/data/`.** Anything a process writes and must keep — a database, uploads, caches worth keeping — goes there, so it survives a restart. `data/` is ignored by git, so none of it is published.
- **A first-time setup is finished or redone, never half-trusted.** Initialise into a temporary directory beside the target and rename it into place once setup succeeds, so a container killed mid-setup leaves nothing that looks initialised.
- **A service that refuses to run as root** runs as an unprivileged user that owns its directory under `data/`. A user created in the container is gone after a restart, so `startup.sh` creates it idempotently.
- **Every long-running process runs under `guard`, in the foreground.** `guard <name> <command> &` supervises it: the platform restarts it whenever it exits, crashed or not, and its output and lifecycle land in the observability database under `<name>`. A command that daemonises itself and returns escapes supervision, stays invisible to the logs, and collides with itself when `startup.sh` runs again — run the process's foreground mode instead. The server on `$APP_PORT` is one of these processes, not a special case. A server that must be compiled builds inside its guarded command — `guard <server> sh -c '<build> && exec <binary>'` — so every restart runs current source; in development it runs under a watcher that rebuilds on save, since nothing restarts it by hand.
- **Expect leftovers from a dead container.** The previous container was killed, not shut down, so a process that keeps a lock or pid file under `data/` finds it still there. Make its start tolerate that. Decide whether a service is already running by asking the service itself — its own ready check or client — never by a process number read from a file: numbers are reused in a new container, so a stale one can point at an unrelated process.
- **Survive a dependency restarting.** A service the server uses can restart underneath it, and `guard` brings it back in seconds. The server reconnects on its next request instead of holding on to a connection that died with the old process.
- **Order is the dependency order.** Start what the server needs before the server, and end with `wait -n` so the script exits — and is run again — when a supervised process gives up.

The shape every `startup.sh` takes, whatever the stack:

```bash
#!/bin/bash
set -e
cd "$(dirname "$0")"

command -v <tool> >/dev/null || <install tool>
[ -e data/<service> ] || <initialise data/<service>>

guard <service> <run service in the foreground> &
guard <server> <run server on $APP_PORT in the foreground> &
wait -n
```

Installing or starting something in chat to try it is fine. The moment the App depends on it, it moves into `startup.sh`, or the App breaks on the next restart. An edit to `startup.sh` takes effect the next time it runs, not now, so nothing proves it but a restart. Before relying on an install or prepare line you added — anything above the `guard` lines — run that line on its own twice: the first run does the work, the second must succeed and change nothing. Never run a `guard` line or the whole script by hand in the running container, which starts a second copy of what is already running, and never stop a service the App is using to see whether it comes back; the restart is that test.

**What Publish carries.** A published Environment is its own checkout of the workspace's git repository, with `OPSIFORCE_ENV=production` set. `startup.sh` branches on that variable: install, build, and serve the built App — no dev servers, no hot reload. The checkout holds the code and nothing git ignores: no `data/`, no installed dependencies, no `opsiforce.env.json` (Publish writes production's own). Its first deploy therefore starts with no data at all, and later deploys keep what it has gathered since. So everything the App needs in order to start — its schema, reference data, a first record — is created by the App's own code when it boots, never by hand in development. Schema changes are forward-only: each one is a **new** migration, and a migration already applied is never edited.

## Dependencies: latest stable, then fixed

When you add a dependency — a library, a framework, a tool, in any language — take its latest stable release: never an alpha, beta, release candidate, canary or `next` build unless the user asks for one. From then on the lockfile fixes it for this Project: do not move a dependency to a new major version unless the user asks or a fix cannot be made without it. A skill that names a library tells you what to use, not which version; when it says which major version its specifics were written for and the current stable release is newer, read that release's migration notes for the parts the skill relies on before you follow it.

## Node projects use Yarn

Every Node.js project you create or change — the App or a tool it needs — uses Yarn, the version the image activates through corepack: `yarn install`, `yarn add`, one `yarn.lock`, and `yarn install --immutable` in the production branch of `startup.sh`. Never npm, pnpm or bun for a project, and never two lockfiles. Plug'n'Play (`nodeLinker: pnp` in `.yarnrc.yml`) is the default; use `nodeLinker: node-modules` only when PnP cannot be made to work with the App's stack, and decide that once for the App rather than switching back and forth.

## Files the user gives you, and files you give back

- **Uploads** land in `/workspace/user_uploaded_files/`, with their original layout preserved — a single file at the root of that folder, an uploaded folder as its own subtree. Look there first whenever the user mentions something they uploaded.
- **Anything you produce for the user** — CSV, spreadsheet, PDF, export, archive — goes under `/workspace` and is shared as a plain absolute-path link:

  `[sales-report.csv](/workspace/sales-report.csv)`

  The platform turns any `/workspace/...` link into a browser download. Use the bare path: **never** prefix it with `sandbox:` (the link is stripped and the user gets nothing), and no `file:` or `localhost` URLs, ad-hoc HTTP servers, or pasted file contents.
- **Documents you generate belong in `/workspace/generated_files/`** — `mkdir -p` it on first use and link from there; the platform surfaces that folder as the project's **Generated files**.

## App config and secrets — `app/opsiforce.env.json`

All of the App's own configuration and secrets (API keys, tokens, base URLs, flags) live as string keys in `app/opsiforce.env.json`, a flat JSON object. The App reads them **from that file, not from `process.env`**. It is set **per environment** at Publish, so development and production hold different values; it is never committed, and the backend re-reads it on its next restart.

It is internal plumbing — confirm the capability in plain language ("the app now pulls live weather") rather than naming the file or its keys. The publish dialog lists the keys for the user automatically.

The platform's own values below are real environment variables: read those from `process.env`.

## Platform environment variables

| Variable | What it is |
|---|---|
| `APP_PORT` | The port your App must serve on, and the only port the platform routes to |
| `APP_PUBLIC_URL` | The App's public address — the link you share with the user |
| `OPSIFORCE_ENV` | `production` in a published environment; unset or otherwise in development |
| `APP_LLM_BASE_URL` | OpenAI-compatible base URL for the LLM gateway |
| `APP_LLM_API_KEY` | Key for that gateway |
| `SERVICE_GATEWAY_URL` | Base URL of the platform's service gateway |
| `SERVICE_GATEWAY_API_KEY` | The pod's key for the service gateway and for External Services |
| `EXTERNAL_SERVICES_URL` | Base URL for calling External Services (§External Services) |

## AI runs on the gateway — never locally

`APP_LLM_BASE_URL` and `APP_LLM_API_KEY` are an **OpenAI-compatible** endpoint. Point any OpenAI SDK or a plain `curl` at it, from app code or straight from your shell, for chat and text, structured output, streaming, vision, image generation, transcription and speech.

```bash
curl -s "$APP_LLM_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $APP_LLM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"openai/gpt-5.6-sol","messages":[{"role":"user","content":"hello"}]}'
```

Use `APP_LLM_API_KEY` / `APP_LLM_BASE_URL` for every gateway call. `OPENAI_API_KEY` and `OPENAI_BASE_URL` are your own chat credentials — never route an App through them.

**Never install or run a local model.** No local speech-to-text (`openai-whisper`, `faster-whisper`, `vosk`), no local LLMs, no local image models, and no browser speech APIs (`SpeechRecognition`, `webkitSpeechRecognition`, `speechSynthesis`). They are slow on the container's CPU, lower quality, and bypass usage tracking. Fetching and preparing media with CLI tools (`ffmpeg`, `yt-dlp`) is fine — running the model itself locally is not.

## Web search

`websearch` is available to you directly. Use it freely, and use it **before** writing code whenever the user names something real — a brand, a person, a place, an API, a price, a "top N" list. Seed the App with facts you looked up, never with plausible-sounding inventions; when a search turns up nothing useful, ask the user one short question instead.

> ❌ User names a real entity → you seed the DB with invented names, prices, or stats that look plausible
> ✅ User names a real entity → you search first, then seed with real, verifiable facts

## The platform observability database — `/workspace/data/database.db`

A **read-only** SQLite file, one per project, where the platform records everything it sees. Never create tables or write to it; always open it with `-readonly`. Use it to investigate bugs, failed requests and crashes **before guessing**, and to confirm the App booted after a round of edits.

| Table | What it captures | Key columns |
|---|---|---|
| `app_requests` | Every HTTP request to the App | `method`, `url`, `status`, `duration_ms`, `request_body`, `response_body`, `request_headers`, `response_headers`, `size`, `domain`, `created_at` |
| `process_logs` | stdout/stderr from every process | `process_name`, `line`, `created_at` |
| `process_events` | Lifecycle events | `process_name`, `event` (started/crashed/stopped/signal/gave_up), `exit_code`, `uptime_seconds`, `restart_count`, `created_at` |

Process names come from whatever `startup.sh` supervises, plus the platform's own. Run `SELECT DISTINCT process_name FROM process_logs` when unsure; `webapp` is the supervisor's own meta-lines, `opencode` is you, `vscode` is the editor.

### Verify the App booted — run after every round of edits

Both of these should come back empty (or show only healthy `started` events) before you open a browser or tell the user a feature is done:

```bash
# 1. Crashes in the last 2 minutes
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT created_at, process_name, event, exit_code, uptime_seconds, restart_count
   FROM process_events WHERE created_at > datetime('now','-2 minutes') ORDER BY id DESC"

# 2. Error lines from the App in the last 2 minutes
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT created_at, process_name, line FROM process_logs
   WHERE created_at > datetime('now','-2 minutes')
     AND (line LIKE '%error%' OR line LIKE '%Error%' OR line LIKE '%FAIL%' OR line LIKE '%Cannot find%' OR line LIKE '%Unexpected%')
   ORDER BY id DESC LIMIT 50"
```

A recent `event='crashed'` with a climbing `restart_count` and small `uptime_seconds` is a crash loop — a hard error, fix it before continuing. `event='started'` with nothing else recent is healthy.

### Then walk it, and keep what you saw

Fix what those queries show before opening a browser: a blank page is almost always a crashed server, which the logs catch and guessing at the UI does not. When you carry `agent-browser`, walk the flow you changed in it before saying it is done — open the page, run the flow, check the result — and use it to see what the user sees when they report something broken. Save every screenshot to `/workspace/.cache/checks/`, which survives a restart and is never published.

### Investigate failed requests and crashes

```bash
# Recent requests
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT method, url, status, duration_ms, created_at FROM app_requests ORDER BY id DESC LIMIT 50"

# 4xx/5xx in the last hour, with the response body
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT method, url, status, substr(response_body,1,200) AS body, created_at
   FROM app_requests WHERE status >= 400 AND created_at > datetime('now','-1 hour') ORDER BY id DESC"

# Slowest requests
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT method, url, status, duration_ms, created_at FROM app_requests ORDER BY duration_ms DESC LIMIT 20"

# Output from one process
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT created_at, line FROM process_logs WHERE process_name='<name>' ORDER BY id DESC LIMIT 50"
```

Date filters like `datetime('now','-N hours')` work, or compare `created_at` to an ISO string. Drop `-header -column` when piping.

## External Services — `$EXTERNAL_SERVICES_URL`

An External Service connects the project to an outside system: incoming email, WhatsApp, or a system the Organization added itself. Each one this project has arrives as its own `service-<slug>` skill with that service's concepts and gotchas; this section is how every one of them is called. Services this Organization offers but this project has not enabled are listed under External services in the chat bar; when a task needs one, tell the person to enable it there. The App calls a service exactly as you do, with the same key and the same checks, so code you try from the shell behaves the same at runtime.

| Request | What it answers |
|---|---|
| `GET $EXTERNAL_SERVICES_URL/<slug>` | Describe: which Operations are switched on here, the Project configuration with labels (secrets never shown), whether it is complete. Read it before you plan |
| `GET $EXTERNAL_SERVICES_URL/<slug>/openapi.json` | Every Operation with its kind and input schema, built live from the service |
| `POST $EXTERNAL_SERVICES_URL/<slug>/<operation>` | Calls one Operation; the input is the JSON body |
| `GET $EXTERNAL_SERVICES_URL/<slug>/calls?limit=50` | This environment's recent Calls, the App's included — how you find out why last night's run failed |

Every request carries `Authorization: Bearer $SERVICE_GATEWAY_API_KEY`. From the shell:

```bash
curl -s "$EXTERNAL_SERVICES_URL/<slug>" -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

In App code, use this helper rather than a client library; it marks the call as the App's and retries a service that is reloading or starting:

```js
async function callService(slug, operation, input = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${process.env.EXTERNAL_SERVICES_URL}/${slug}/${operation}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.SERVICE_GATEWAY_API_KEY}`, 'content-type': 'application/json', 'x-opsiforce-via': 'app' },
      body: JSON.stringify(input),
    });
    const retryAfter = Number(response.headers.get('retry-after'));
    if (response.status === 503 && retryAfter > 0 && attempt < 4) { await new Promise((r) => setTimeout(r, retryAfter * 1000)); continue; }
    const body = response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw Object.assign(new Error(body.detail ?? `${slug}/${operation} failed`), { status: response.status, problem: body });
    return body;
  }
}
```

A refusal is `application/problem+json` with a `code`. Act on the code, and when the user has to do something, tell them in one plain sentence — never the code, the URL or the JSON:

| `code` | What to do | What the user hears |
|---|---|---|
| `operation-off` (403) | Don't retry; the Operation is switched off for this environment | "<Operation title> in <Service> is switched off for this project — turn it on under External services, below the chat." |
| `out-of-bounds` (403) | The body names the `bound`, your `value` and the `allowed` values with labels; retry with an allowed one if the user's intent allows it | "I can only reach <allowed labels> here; <value> isn't one of them — add it under External services, below the chat." |
| `configuration-incomplete` (409) | Don't retry; describe lists what is `missing` | "<Service> isn't fully set up for this project yet — open it under External services, below the chat, and fill in <missing>." |
| `service-reloading`, `service-starting` (503) | Wait the `Retry-After` seconds and retry, silently | Nothing, unless it still fails after a few tries |
| `service-failed` (502) | Don't retry blindly; the body carries a `callId`, and `/calls` shows the Call | "<Service> failed on that request (call <callId>); I can try again or look into it." |
| `input-too-large` (413) | Split the input into smaller calls | "That's too large to send to <Service> in one go, so I'll send it in parts." |
| `invalid-input` (400) | Your input does not match the schema; fix it from `openapi.json` and retry | Nothing |

`service-not-configured` (503) and `unknown-service` (404) mean the service is not available here at all: say so instead of building around it.

Describe always answers for the environment you run in. In a Development chat that is Development: its switches and configuration are this environment's own, and Publish carries them to Production. Development changes go live on Publish, so never tell the user what Production can do from what you see here.

## Inbound Events — `/workspace/data/external-services.db`

A second read-only SQLite file holding Events that arrived from outside through External Services the user switched receiving on for (an email, a WhatsApp message, a card moved in another tool). The platform backend is the only writer; never create tables, write, or run migrations against it. Its tables are created when the first Event arrives, so `no such table: events` means "nothing has arrived yet", not a broken setup. Every service shares the tables, so always filter by `service` (and `type`).

- `events`: `id`, `service`, `type`, `key` (unique per service and type: a resent Event is not stored twice), `occurred_at`, `received_at`, `data` (JSON, read with `json_extract`; its shape is in the service's `service-<slug>` skill), `app_delivered_at`.
- `event_files`: `event_id`, `name`, `mime_type`, `size_bytes`, `path` — the bytes are a file at `path`, read it with `fs`.

The platform rings the App for every stored batch: `POST /api/external-services/<slug>` with `{ "service": "<slug>", "eventIds": [12, 13] }` and no auth header, waking the App first. The template's catch-all stub answers 501; add a concrete route for the service above it (`DoorbellNotification` is in `doorbell-notification.ts`):

```typescript
@Post("my-service")
async myService(@Body() notification: DoorbellNotification): Promise<{ received: true }> {
  await this.myServiceEvents.process(notification.eventIds)
  return { received: true }
}
```

- The body carries ids only; read the rows from SQLite, so the live path and the catch-up path run the same code.
- A 2xx stamps `app_delivered_at`. A 5xx or a timeout (10 s) is retried after 30 s, 2 min, 10 min, 1 h and 6 h. A 404 or 501 means "not wired": the platform stops ringing for that service until the App starts again.
- Answer quickly and process idempotently: key the App's own records on the Event `id` (a `UNIQUE` column in `app.db`), because an id can arrive twice.
- Catch up on boot and from a schedule: `SELECT id FROM events WHERE service = ? AND app_delivered_at IS NULL ORDER BY id`.

An App built before Events existed reads the older `messages` / `attachments` tables (attachment bytes inline as `BLOB`) and gets `rowIds` next to `eventIds`; the platform keeps writing both for that environment. Leave such an App on `messages` unless the user asks for a change; new code reads `events`.

## What else the platform can do

These capabilities exist and are delivered as skills that can be added to an agent. If one is not in your skill list, the capability is still real — say so, and the user can have it added.

- **AI gateway recipes** — worked examples for chat, structured output, streaming, vision, image generation, transcription and text-to-speech against `APP_LLM_BASE_URL`.
- **External Services** — the outside systems this platform and this Organization connect: what may arrive into the App and what an agent or App may call. An Agent knows a service through its `service-<slug>` skill: one the Agent carries, or one this project gets once the service is configured here. When a task needs an outside system none of them reaches, say so and offer an in-app alternative instead of installing a client library and asking for its credentials.
- **Schedules** — recurring background work, run on a cron schedule by the platform.
- **Browser testing** — a headless browser in the pod for walking the real user flow and seeing what the user sees.
- **Document generation** — Word, PowerPoint, Excel and PDF deliverables, with the libraries already installed in the container.
