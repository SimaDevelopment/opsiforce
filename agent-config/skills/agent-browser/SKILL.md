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

Verify the App booted before opening the browser (`platform` §Verify the App booted). Then pair what the browser shows with the platform database:

1. Open the app at `http://localhost:$APP_PORT` — see what the user sees
2. Take a snapshot to inspect the DOM
3. Check the failed requests and process errors behind it (`platform` §Investigate failed requests and crashes)
