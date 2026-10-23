---
name: platform
description: The Opsiforce platform contract every agent runs under — an App is `/workspace/app/startup.sh` serving on `$APP_PORT`, and it goes live the moment `app/app.meta.json` exists. Also covers what a pod restart wipes and what the workspace keeps, uploaded and generated files, `app/opsiforce.env.json` and Publish, the platform environment variables, the LLM gateway and the ban on local models, reaching External Services on their Service hosts and relaying their refusals, and the two read-only platform databases. Load it before building, serving, installing, or debugging anything.
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
- **Every long-running process runs under `guard`, in the foreground.** `guard <name> <command> &` supervises it: the platform restarts it whenever it exits, crashed or not, and its output and lifecycle land in `/workspace/data/logs/<name>.log`, read with `process-logs <name>`. A command that daemonises itself and returns escapes supervision, stays invisible to the logs, and collides with itself when `startup.sh` runs again — run the process's foreground mode instead. The server on `$APP_PORT` is one of these processes, not a special case. A server that must be compiled builds inside its guarded command — `guard <server> sh -c '<build> && exec <binary>'` — so every restart runs current source; in development it runs under a watcher that rebuilds on save, since nothing restarts it by hand.
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
| `EXTERNAL_SERVICES_HOST` | The domain every External Service's host sits under: `<slug>.$EXTERNAL_SERVICES_HOST` (§External Services) |

## AI runs on the gateway — never locally

`APP_LLM_BASE_URL` and `APP_LLM_API_KEY` are an **OpenAI-compatible** endpoint serving GPT and Claude models. Point the `openai` SDK or a plain `curl` at it, from app code or straight from your shell, for text, structured output, streaming, vision, image generation, transcription and speech. The Organization chooses which providers serve each model family, and two rules keep every call on that choice: name models by their **bare id** (`gpt-6.1-sol`, `claude-sonnet-5-5`), since a `provider/` prefix pins a single provider; and make every text call a **streamed Responses call** (`/responses` with `"stream": true`), OpenAI's recommended API, which every provider serves.

```bash
curl -sN "$APP_LLM_BASE_URL/responses" \
  -H "Authorization: Bearer $APP_LLM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-6.1-sol","input":"hello","stream":true,"store":false}'
```

Use `APP_LLM_API_KEY` / `APP_LLM_BASE_URL` for every gateway call. `OPENAI_API_KEY` and `OPENAI_BASE_URL` are your own chat credentials — never route an App through them.

**Never install or run a local model.** No local speech-to-text (`openai-whisper`, `faster-whisper`, `vosk`), no local LLMs, no local image models, and no browser speech APIs (`SpeechRecognition`, `webkitSpeechRecognition`, `speechSynthesis`). They are slow on the container's CPU, lower quality, and bypass usage tracking. Fetching and preparing media with CLI tools (`ffmpeg`, `yt-dlp`) is fine — running the model itself locally is not.

## Web search

`websearch` is available to you directly. Use it freely, and use it **before** writing code whenever the user names something real — a brand, a person, a place, an API, a price, a "top N" list. Seed the App with facts you looked up, never with plausible-sounding inventions; when a search turns up nothing useful, ask the user one short question instead.

> ❌ User names a real entity → you seed the DB with invented names, prices, or stats that look plausible
> ✅ User names a real entity → you search first, then seed with real, verifiable facts

## Platform observability — process logs and the request log

The platform records what every process prints and every request the App serves. Use both to investigate bugs, failed requests and crashes **before guessing**, and to confirm the App booted after a round of edits. Both are the platform's and read-only to you, and both keep only the last few days.

### Process logs — `process-logs`, files under `/workspace/data/logs/`

Every supervised process writes its stdout/stderr and its lifecycle events (`started`, `crashed`, `stopped`, `signal`, `gave_up`, with `exit_code`, `uptime_seconds` and `restart_count`) to `/workspace/data/logs/<process>.log`, rotated as it grows. Read them with `process-logs`, which merges the rotated files and every process by time:

```bash
process-logs --list                # every process, its last write and size
process-logs -n 100 <process>      # the last 100 lines of one process
process-logs --follow <process>    # stream while you reproduce something
```

`--since`, `--events` and `--grep` narrow any of these; `process-logs --help` has the rest. Process names come from whatever `startup.sh` supervises, plus the platform's own: `webapp` is the supervisor's own meta-lines, `opencode` is you, `vscode` is the editor, `dbviewer` the database viewer.

### The request log — `/workspace/data/database.db`

A SQLite file holding one table, `app_requests`: every HTTP request to the App. Always open it with `-readonly`.

| Column | |
|---|---|
| `method`, `url`, `status`, `duration_ms`, `size`, `domain`, `created_at` | what was asked and how it went |
| `request_body`, `response_body`, `request_headers`, `response_headers` | the payloads, when the Project's Request Logging level records them |

### Verify the App booted — run after every round of edits

Both of these should come back empty (or show only healthy `started` events) before you open a browser or tell the user a feature is done:

```bash
# 1. Crashes in the last 2 minutes
process-logs --events --since 2m

# 2. Error lines in the last 2 minutes
process-logs --since 2m --grep 'error|fail|cannot find|unexpected'
```

A recent `crashed` event with a climbing `restart_count` and small `uptime_seconds` is a crash loop — a hard error, fix it before continuing. `started` with nothing else recent is healthy.

### Then walk it, and keep what you saw

Fix what those commands show before opening a browser: a blank page is almost always a crashed server, which the logs catch and guessing at the UI does not. When you carry `agent-browser`, walk the flow you changed in it before saying it is done — open the page, run the flow, check the result — and use it to see what the user sees when they report something broken. Save every screenshot to `/workspace/.cache/checks/`, which survives a restart and is never published.

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

# What one process printed around a failure
process-logs --since 15m <name>
```

`created_at` is UTC, as are the log timestamps, so a failed request and the process lines around it line up. Date filters like `datetime('now','-N hours')` work, or compare `created_at` to an ISO string. Drop `-header -column` when piping.

## External Services — `https://<slug>.$EXTERNAL_SERVICES_HOST`

An External Service connects the project to an outside system: incoming email, WhatsApp, or a system the Organization added itself. Each one this project has arrives as its own `service-<slug>` skill: what the service is for, which outside API it passes through and where that API's docs are, how calling it here differs, how to set up your tools for it, and the `data` of each Event it delivers. This section is what every service shares. Services this Organization offers but this project has not connected are listed under External services in the chat bar; when a task needs one, tell the person to connect it there.

### The Service host and your key

Every service answers on its own host, `https://<slug>.$EXTERNAL_SERVICES_HOST`, and speaks its outside system's own API there. Point that system's own client — its CLI, its SDK, git, curl — at the Service host in place of the system's address, and use the system's own paths and docs. The service adds the outside system's credentials itself.

Your credential is `$SERVICE_GATEWAY_API_KEY`, sent in a header and never in a URL:

```bash
curl -s "https://<slug>.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

Any header carries it, Basic auth included (the key as username or password), so a tool that only offers its own auth header works too. The Service skill says how to set up each of its tools to send the key on the first request without stopping at a password prompt. A URL lands in shell history, git remotes and logs, so give a tool the key through its header setting even where it would accept `https://user:key@…`.

App code calls the same host with the same key, read from `process.env` on the App's server and kept out of the browser, so what you try from the shell behaves the same at runtime.

The host holds a request for up to a minute while a sleeping service wakes, so a slow first answer is normal.

### Read `/.well-known/opsiforce` before you plan

`GET https://<slug>.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce` is the service's live answer for this ProjectEnvironment. Read it before you plan work with a service, and again after the user changes a setting:

- `upstreams` — each outside API the service passes through: `api` (name and version), its real `url`, and the `mount`, the path prefix on the Service host that stands for that `url`.
- `routes` — what the service serves, in order, first match wins: the pattern, `action` (`proxy` passes the request to an upstream, `handle` is answered by the service itself as its skill describes, `refuse` is blocked), a `summary`, and `allowedBy`, the settings that govern it. A request no route matches is refused.
- `configuration` — this Project's settings by field, with labels and secrets masked, and `settingsLink`, the page where they change.

A summary says when a route filters an answer or changes a request: read it as a difference from the outside system's docs. The settings and `allowedBy` tell you which requests a task takes; whether one is allowed is the service's to decide, from the request itself, so the answer holds no verdicts.

`/.well-known/opsiforce` answers for the environment you run in. In a Development chat that is Development's own configuration, which Publish carries to the published environment: Development changes go live on Publish, so never tell the user what Production can do from what you see here.

### Make the request; the service decides

Only the service decides what this Project may do. When the user asks for something, make the request it takes and relay the answer, also when the settings suggest a refusal: the service's refusal carries the reason, the setting and its link, and its Call log shows the people who configure it what was asked for.

To act on something the user names without an id, find it through the service the way its outside system's API finds things (a search, a list) and use what comes back. An empty or filtered answer is the service's answer: tell the user the service returned nothing by that name for this Project and give the `settingsLink`, leaving the reason to the service. An id or a link the user gives you goes into the request as it is.

Tell the user something is refused, unavailable or not found only from a service answer to a request you made for it.

### Relay a refusal

The service refuses in your client's own format, so your tool prints it: a CLI's error, git's `remote:` lines, a JSON body. The message says what was refused and why, names the setting and links to it. Every answer the service makes itself carries an `Opsiforce-Outcome` header, plus `Opsiforce-Setting: <field>` when a setting governs it:

- `not allowed` — the service's policy forbids the request: this Project's settings when `Opsiforce-Setting` names one, otherwise something only the person the message names can change, such as an Organization admin on the service's page. Stop and relay it. A *not allowed* is final: never retry it, and never reach the same result another way.
- `not connected` — this Project has no connection to the service. Relay it: the user connects the service under External services in the chat bar.
- `incomplete` — a required setting is empty. Relay it, naming the setting.
- `not supported` — the service does not serve this request. Look for a route that does in `/.well-known/opsiforce`, or tell the user this service cannot do it.
- `failed` — the service or the outside system failed. Retry once when the request is safe to repeat, then report it.

To relay, tell the user in one or two plain sentences what you tried, why it was refused and which setting decides it, give the link from the message, and add whom to ask: the person the message names, or, when they can't change it there, someone who can configure this Project's External Services. Leave the status, headers and JSON out.

The host answers some requests before any service sees them: `401` when no valid key was in a header or this Project is disabled; `404` when this Organization has no such service, or "<service> is turned off in this Organization", so say it is not available here instead of building around it; `502` or `504` when the service failed to start or did not start in time, so retry once a little later, then report it.

In App code a refusal reaches the App's end users, who cannot open the settings link: the App shows its own "not available" message and logs the refusal's message for whoever maintains it. That includes the host's `404`, which has no `Opsiforce-Outcome`: trying again will not help, so only a `failed`, `502` or `504` invites the user to retry.

## Inbound Events — `/workspace/data/external-services.db`

A second read-only SQLite file holding Events that External Services delivered to this environment, as each service's own settings for this Project choose (an email, a WhatsApp message, a card moved in another tool). The platform backend is the only writer; never create tables, write, or run migrations against it. Its tables are created when the first Event arrives, so `no such table: events` means "nothing has arrived yet", not a broken setup. Every service shares the tables, so always filter by `service` (and `type`).

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
- A 2xx stamps `app_delivered_at`. A 5xx or a timeout (10 s) is retried after 30 s, 2 min, 10 min, 1 h and 6 h. A 404 or 501 means "not wired": the platform stops ringing for that service until the App starts again. Reloading the server under its watcher does not count, so when you wire a service that already has Events waiting, tell the user they arrive at the App's next start, or at once if they restart this environment.
- Answer quickly and process idempotently: key the App's own records on the Event `id` (a `UNIQUE` column in `app.db`), because an id can arrive twice.
- Catch up on boot and from a schedule: `SELECT id FROM events WHERE service = ? AND app_delivered_at IS NULL ORDER BY id`.

An App built before Events existed reads the older `messages` / `attachments` tables (attachment bytes inline as `BLOB`) and gets `rowIds` next to `eventIds`; the platform keeps writing both for that environment. Leave such an App on `messages` unless the user asks for a change; new code reads `events`.

## What else the platform can do

These capabilities exist and are delivered as skills that can be added to an agent. If one is not in your skill list, the capability is still real — say so, and the user can have it added.

- **AI gateway recipes** — worked examples for text generation, structured output, streaming, multi-turn conversations, tool calling, vision, image generation, transcription and text-to-speech against `APP_LLM_BASE_URL`.
- **External Services** — the outside systems this platform and this Organization connect: what may arrive into the App and what an agent or App may call. An Agent knows a service through its `service-<slug>` skill: one the Agent carries, or one this project gets once the service is configured here. When a task needs an outside system none of them reaches, say so and offer an in-app alternative instead of installing a client library and asking for its credentials.
- **Schedules** — recurring background work, run on a cron schedule by the platform.
- **Browser testing** — a headless browser in the pod for walking the real user flow and seeing what the user sees.
- **Document generation** — Word, PowerPoint, Excel and PDF deliverables, with the libraries already installed in the container.
