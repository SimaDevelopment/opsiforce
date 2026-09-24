---
name: schedules
description: Scheduled/cron background tasks — use when the user asks for recurring tasks, cron jobs, periodic checks, or "run X every Y" — any background work that needs to run on a schedule.
---

# Scheduled Tasks

Register cron-scheduled HTTP callbacks that fire against endpoints in the app you're building. The platform scheduler calls the endpoint internally (intra-cluster) at `http://<pod-ip>:$APP_PORT<targetPath>` — NOT the public URL — so it does not need to be publicly reachable or handle auth. If the pod is suspended when a schedule fires, the platform wakes it automatically.

Typical use cases:

- Periodic data refresh or cleanup (e.g. purge records older than 30 days every night)
- Recurring reminders shown in the app UI (e.g. mark overdue tasks every hour)
- Health checks and self-maintenance jobs
- Aggregating or rolling up data on a schedule (e.g. compute daily/weekly summaries into a table)
- Polling an external API on an interval and caching the result
- Copying, moving, or syncing files on a cadence (e.g. archive yesterday's uploads into a dated folder every night, mirror a source directory into a backup location hourly, rotate log files weekly)

The scheduler is general-purpose — use it for any background work that needs to run on a cadence. It is not tied to any specific output channel.

## Create a Schedule

**Step 1**: Build the target endpoint in the app first (follow the nestjs-api skill).

**Step 2**: Register the schedule:

```bash
curl -s -X POST "$SERVICE_GATEWAY_URL/schedules" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily cleanup",
    "cronPattern": "0 3 * * *",
    "targetPath": "/api/cron/cleanup",
    "method": "POST"
  }'
```

### Request Body

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | **User-facing display name.** Unique per project, used as upsert key. |
| `cronPattern` | Yes | 5-field cron: `minute hour day-of-month month day-of-week` |
| `targetPath` | Yes | App endpoint path (e.g. `/api/cron/cleanup`) |
| `method` | No | HTTP method. Default: `POST` |
| `body` | No | JSON body sent with the request |
| `headers` | No | Additional headers as `{ "key": "value" }` |

### Naming Rules — IMPORTANT

The `name` is **shown to the user in the UI**. It must be human-readable:

- ✅ **Good**: `"Daily cleanup"`, `"Hourly health check"`, `"Weekly rollup"`, `"Refresh exchange rates"`
- ❌ **Bad**: `"daily-cleanup"`, `"weekly_rollup"`, `"cron1"`, `"schedule-1"`, `"job"`

Use sentence case with spaces. Be descriptive but concise (3-6 words). The name should make sense to a non-technical user who opens the Schedules page. Keep it stable — the same name upserts the schedule.

### Cron Pattern Examples

| Pattern | Meaning |
|---------|---------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First day of every month at midnight |

Timezone is captured automatically from the user's browser. Do NOT ask the user about timezone.

## List Schedules

```bash
curl -s "$SERVICE_GATEWAY_URL/schedules" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

## Delete a Schedule

First list schedules to find the id, then delete by id:

```bash
ID=$(curl -s "$SERVICE_GATEWAY_URL/schedules" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" \
  | jq -r '.[] | select(.name == "Daily cleanup") | .id')

curl -s -X DELETE "$SERVICE_GATEWAY_URL/schedules/$ID" \
  -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY"
```

## What Scheduled Endpoints Can Do

A scheduled endpoint is just a regular endpoint in your app. When it fires, it can do anything your app can do — query the database, call external HTTP APIs, update in-app state, write to files in the app's workspace, etc.

Pick the output that fits the use case. A few patterns:

- **Update in-app data** — write a summary row, mark stale records, refresh a materialized view. Users see the result next time they open the relevant page.
- **Call an external HTTP API** — if the job needs to push to a third-party service, do it with `fetch` from inside the endpoint handler. Any key or base URL it reads is App configuration (`platform` §App config and secrets), set per environment — so the same schedule can hit a test endpoint in dev and the real one in production.
- **Log and surface in the UI** — append to a `job_runs` table so the user can see in the app whether the scheduled job succeeded.

> A scheduled email (daily digest, weekly report, reminder) becomes an in-app alternative — see `send-email`.

## Important Notes

- Register a schedule only after its endpoint exists (Step 1). If you register one for a non-existent endpoint, the scheduler will record HTTP errors.
