---
name: platform
description: The Opsiforce platform contract every agent runs under — an App is `/workspace/app/startup.sh` serving on `$APP_PORT`, and it goes live the moment `app/app.meta.json` exists. Also covers uploaded and generated files, `app/opsiforce.env.json` and Publish, the platform environment variables, the LLM gateway and the ban on local models, and the two read-only platform databases. Load it before building, serving, or debugging anything.
---

# The Opsiforce platform

You run inside a per-project pod on the Opsiforce platform. Everything below is true of every project, whatever stack you build in.

## The App contract

An **App** is three things. Satisfy them and the platform routes to it, shows a preview pane, reports it live, and publishes it. Miss one and nothing appears.

1. **`/workspace/app/startup.sh`** — an executable shell script that starts your server in the foreground. The platform runs it, restarts it when it exits, and runs it again in the published environment. Never start a server any other way: a process you launch yourself is not supervised and dies with your shell. Anything else the App needs running — a database server you installed, a worker, a queue — starts from this same script, with its data under `/workspace/app/` so it survives a restart.
2. **It serves HTTP on `$APP_PORT`.** Read the port from the environment — never hardcode it. Any HTTP answer on that port, at any status, counts as serving; the platform does not require a health route.
3. **`/workspace/app/app.meta.json`** — `{"name": "…", "description": "…"}` and nothing else. Writing this file is **go-live**: it makes the preview pane appear and the public link work. Write it as soon as the first feature works, not at the end.

```bash
chmod +x /workspace/app/startup.sh
```

Until `startup.sh` exists the pod idles quietly — there is no penalty for a workspace with no App yet.

If `app.meta.json` already exists, leave its `name` and `description` alone. Users edit them from the platform and their edits must survive your changes; rewrite them only when the user asks to rename the App.

The App's public address is in `APP_PUBLIC_URL`. Share that link once, when you first create `app.meta.json` — never the `localhost` address, and never again on later edits.

**One Project is one App.** A project holds exactly one App and one conversation. If the user wants a different App, they start a new project.

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
| `SERVICE_GATEWAY_API_KEY` | The pod's key for the service gateway |
| `EXTERNAL_SERVICES_URL` | Base URL for the external-services endpoints |

`OPSIFORCE_ENV=production` means the App runs built, with no hot reload, and its database migrations run automatically on boot — so every schema change must be a **new** migration file; never edit one that has already been applied.

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

`websearch` is available to you directly. Use it freely, and use it **before** writing code whenever the user names something real — a brand, a person, a place, an API, a price, a "top N" list. Seed the App with facts you looked up, never with plausible-sounding inventions.

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
  "SELECT created_at, line FROM process_logs WHERE process_name='app-backend' ORDER BY id DESC LIMIT 50"

# Lifecycle events
sqlite3 -readonly -header -column /workspace/data/database.db \
  "SELECT created_at, process_name, event, exit_code, uptime_seconds, restart_count
   FROM process_events ORDER BY id DESC LIMIT 50"
```

Date filters like `datetime('now','-N hours')` work, or compare `created_at` to an ISO string. Drop `-header -column` when piping.

## Inbound messages — `/workspace/data/external-services.db`

A second read-only SQLite file holding messages that arrived from outside — inbound email, WhatsApp. The platform backend is the only writer; never create tables, write, or run migrations against it. Its two tables (`messages`, `attachments`) are created lazily when the first message arrives, so `no such table: messages` means "nothing has arrived yet", not a broken setup. Every service shares the tables, so always filter by `service`.

## What else the platform can do

These capabilities exist and are delivered as skills that can be added to an agent. If one is not in your skill list, the capability is still real — say so, and the user can have it added.

- **AI gateway recipes** — worked examples for chat, structured output, streaming, vision, image generation, transcription and text-to-speech against `APP_LLM_BASE_URL`.
- **Inbound email** — an App can be given its own address; mail with attachments lands in the external-services database and rings the App. **Sending** email is not supported by the platform; offer an in-app alternative instead of installing a mail library.
- **WhatsApp intake** — inbound messages, photos, documents and voice notes from allowlisted chats and groups. Inbound only.
- **Schedules** — recurring background work, run on a cron schedule by the platform.
- **Browser testing** — a headless browser in the pod for walking the real user flow and seeing what the user sees.
- **Document generation** — Word, PowerPoint, Excel and PDF deliverables, with the libraries already installed in the container.
