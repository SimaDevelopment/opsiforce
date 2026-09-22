---
name: agent-browser
description: Browser automation for testing and debugging — open pages, take snapshots, click/fill elements, inspect network requests, verify UI. Use when you need to visually test the app, verify a feature works, debug UI issues, or investigate what the user sees.
---

# agent-browser

Browser automation tool for testing your app and debugging UI issues. Chrome/Chromium via CDP with accessibility-tree snapshots and compact `@eN` element refs.

## Discovering commands

Don't guess at commands — ask the CLI. It serves version-matched docs so instructions never go stale:

```bash
agent-browser skills list                 # every skill available on the installed version
agent-browser skills get core             # workflows, common patterns, troubleshooting
agent-browser skills get core --full      # full command reference and templates
agent-browser --help                      # top-level help
agent-browser <command> --help            # help for a specific command
```

Run `agent-browser skills get core --full` before your first interaction in a session — it has the canonical commands for navigating, snapshotting, clicking, filling, waiting, network inspection, and evaluating JS in the page.

## Debugging workflow

**Before opening the browser**, verify the App booted — the crash and error queries are in the `platform` skill, §Verify the App booted (App Builder's template adds `cd /workspace/app && yarn check` for type errors). A blank page is almost always a crashed process, not a UI bug.

When investigating UI issues, pair browser output with those platform-DB queries:

1. Open the app at `http://localhost:$APP_PORT` — see what the user sees
2. Take a snapshot to inspect the DOM
3. Query `app_requests` for failed API calls (4xx/5xx + response body)
4. Query `process_logs` / `process_events` for dev-server errors or crashes
