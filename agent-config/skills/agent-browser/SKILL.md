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

## Visible browser and handing it to the user

Use a headed browser when the user needs to see or use it (`platform` §When the user has to see or do something themselves). The agent and its child processes inherit `DISPLAY=:99`; a window on it shows to the user beside the chat. The display is lightweight while empty, and VNC streaming runs only while someone is looking at it.

When you write to the user, call it "the screen beside the chat". Never write "desktop", "Desktop panel" or "preview panel": `desktop` is only the name of the command.

```bash
agent-browser --headed open https://example.com
desktop list                 # the window IDs and titles
desktop show                 # bring the whole screen up beside the user's chat
desktop show 0x00400003      # bring up one window; use an ID from desktop list
```

All GUI apps share the one screen, including apps started by child agents. Use distinct `agent-browser --session NAME --headed` sessions when needed; they still use `DISPLAY=:99`. Close an app when you are done with it.

Show the whole screen when the flow has popups, several windows or native dialogs: a single-window view shows only that window. The user can switch between the two.

To hand the screen to the user (signing in, a consent screen, a verification check):

1. `desktop show` the window, then ask with the `question` tool, saying exactly what to do on the screen shown beside the chat (for example "Sign in to example.com in the screen on the right, then choose Done"), with the options `Done` and `I couldn't do it`. Asking this way keeps your turn paused and lists the Project under Waiting for input until they answer.
2. While the question is open, do nothing in that browser: no clicks, typing, snapshots or screenshots. What the user types there is theirs.
3. When they answer `Done`, continue in the same browser session, so their sign-in is kept, and check that it worked before going on. On `I couldn't do it`, ask what got in the way.

Never ask for a password, code or token in chat.

If `desktop` is not installed in this environment yet, tell the user the screen appears once they restart the project (Restart in its menu), and do not look for another way to show a window.
