---
name: agent-browser
description: Browser automation for testing and debugging — open pages, take snapshots, click/fill elements, inspect network requests, verify UI. Use when you need to visually test the app, verify a feature works, debug UI issues, or investigate what the user sees.
---

# agent-browser

Browser automation tool for testing your app and debugging UI issues. Chrome/Chromium via CDP with accessibility-tree snapshots and compact `@eN` element refs.

## Discovering commands

Ask the CLI; it serves docs that match the installed version:

```bash
agent-browser skills list                 # every skill available on the installed version
agent-browser skills get core             # workflows, common patterns, troubleshooting
agent-browser skills get core --full      # full command reference and templates
agent-browser --help                      # top-level help
agent-browser <command> --help            # help for a specific command
```

Run `agent-browser skills get core` before your first interaction in a session: workflows, common patterns, troubleshooting. Reach for `agent-browser <command> --help`, or `skills get core --full`, when a command you need is not in it.

## Debugging workflow

Verify the App booted before opening the browser (`platform` §Verify the App booted). Then pair what the browser shows with the platform database:

1. Open the app at `http://localhost:$APP_PORT` — see what the user sees
2. Take a snapshot to inspect the DOM
3. Check the failed requests and process errors behind it (`platform` §Investigate failed requests and crashes)

## Visible browser and desktop handoff

Use a headed browser when the user needs to see or interact with it. The agent and its child processes inherit `DISPLAY=:99`; GUI windows appear in the project's preview panels automatically. The display is lightweight while empty, and VNC streaming runs only while a viewer is connected.

```bash
agent-browser --headed open https://example.com
desktop list                         # sessions, DISPLAY values, window IDs and titles
desktop show                 # present the entire desktop
desktop show 0x00400003      # present one window; use an ID from desktop list
```

All GUI apps share the single desktop, including apps launched by child agents. Use distinct `agent-browser --session NAME --headed` browser sessions when needed; they still use `DISPLAY=:99`. Up to 10 VNC views can show the whole desktop or its individual windows. Collapsing a preview disconnects its viewer without stopping the app. Close the app itself when finished.

Choose a whole-desktop view when the workflow involves several windows, popups or native dialogs. A selected-window view only captures that window; separate dialogs may require switching back to the desktop. The user can change the selection too.

When asking the user to interact (for example signing in), present the appropriate window, tell them to click inside the desktop to interact, and pause browser automation until they say they are done. Do not type or click concurrently with the user. Resume using the same browser session so their changes are preserved. Never collect passwords from the user in chat.
