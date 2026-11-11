---
kind: explanation
terms: [Desktop]
adrs: [0109]
---

# Desktop

> How does a person see and use a GUI app running inside an Agent's pod, and how does the Agent hand it to them?

## How it works

### The display

- Every agent pod runs one Xvfb display, `:99`, with Openbox on a single workspace, under `guard`; Openbox maximizes every normal window without a title bar, so an app fills the screen; every process in the pod inherits `DISPLAY`, sub-agents and the App included ([ADR-0109](../adr/0109-an-agent-pod-has-one-desktop-streamed-per-viewer-through-the-agent-proxy-and-announced-by-a-held-stream.md)). There is no second display and no desktop environment.
- `BROWSER` and the XDG defaults point at `desktop-browser`, so any "open in browser" — a CLI login, a link in a GUI app — lands in Chromium on `:99`, and the launcher runs `desktop show` on the window it opened, so a login a command starts comes up for the user. It adds `--no-sandbox` only as root, and skips certificate checks where the pod sets `AGENT_BROWSER_IGNORE_HTTPS_ERRORS=1`, as agent-browser does.
- Pods mount a memory-backed `/dev/shm` capped at 512 MiB for Chromium and Electron; pages count toward the agent's memory limit and reserve nothing.
- The Agent runs `desktop list` for the windows and their IDs, and `desktop show [WINDOW_ID]` to bring the whole desktop or one window up for the user.

### Streaming

- A Go manager on `127.0.0.1:6080` lists windows with `wmctrl` and starts one x11vnc per viewer, reverse-connected to a loopback listener it owns; no VNC port ever listens, and x11vnc lives only while its viewer is connected, at most 10 at once.
- The browser connects to `wss://<opsiforce>/api/proxy/<environment-id>/_desktop/sessions/default/connect` through the agent runtime proxy, which checks project access and, for `/_desktop/`, a same-origin `Origin`; agent-control routes `/_desktop/` to the manager. Inside the cluster only the runtime proxies and the backend reach that port ([ADR-0106](../adr/0106-agent-pods-reach-only-the-platform-services-they-call-and-the-internet-and-only-platform-roles-reach-them.md)).
- The project page learns about windows from the held stream `GET …/_desktop/sessions/events`, which the manager writes when the window list or a presentation changes; it counts as one activity touch at connect.

### The panel

- Desktop is a mode of the preview panel beside App and [File preview](file-preview.md), labelled **Browser** while every window on it is a browser and **Screen** otherwise, the words the user sees instead of "desktop"; it exists only while the display has a window. The header's switcher lists the modes that exist, and on a phone the panel is the bottom bar's Preview overlay.
- `desktop show` opens the panel in Desktop mode on the window named, only for a show that happens while the page is open.
- With two or more windows the header picks all windows or one, and holds Full screen and the Clipboard controls. A hidden view disconnects its viewer; the apps keep running.
- Input starts on the first click inside the viewer. Ctrl, Cmd and Alt combinations typed there go to the desktop, never to the chat's shortcuts, with Cmd sent as Ctrl because the desktop is Linux.
- UTF-8 text crosses through `GET`/`PUT …/_desktop/clipboard`, which agent-control serves with `xclip` on `:99`, capped at 1 MiB; Ctrl/Cmd+C, X and V use it, and the Clipboard box covers browsers that block clipboard access and copies made from an app's own menu. Text reaches the person's clipboard only on their own copy, never on a timer.

### Handing over

- The `platform` skill tells every Agent when a step needs the person — a sign-in, an approval, a verification, or the user asking to see it — and to hand the desktop over by asking with the `question` tool (Done / I couldn't do it), which keeps the turn paused and lists the Project under Waiting for input; the Agent leaves that screen alone until the answer, then continues in the same session.
- The person answers that question in the chat; the panel shows no copy of it.
- When someone clicks into the screen while the Agent is still working and not waiting on them, a strip warns that it may use the screen too and offers **Stop the agent**, which interrupts the chat they have open through opencode's interrupt.
- The `platform` skill also has the Agent ask before any step that commits the person — paying, sending as them, accepting terms, creating an account, deleting or publishing their data — or hand the screen over for it.
- Control is cooperative: every member who opens the Project, and every chat session in it, can type into the same desktop.

## Edge cases

- When the display does not come up within ten seconds, the pod logs it and starts the Agent without waiting.
- When the event stream fails four times in a row, the page stops retrying until the tab becomes visible again or the environment reconnects.
- When the viewer cannot connect eight times in a row, the panel says the desktop can't be reached and offers Try again.
- When the page is on a phone, the panel shows a note to use a computer, and does not connect a viewer, because the fixed 1440×900 screen is unreadable at that width.
- When a pod runs an image without the desktop, the panel shows no Desktop mode, and the skill asks the user to restart the project instead.
- When a single window is shown, dialogs and popups opened as separate windows show only in the whole-desktop view, and a covered or minimized window can show stale content.

## Code

- `proxy/internal/desktop/` — the manager: display, window list, event stream, viewers and the clipboard handler.
- `proxy/cmd/agent-desktop/`, `proxy/cmd/agent-control/opencode_proxy.go` — the manager's process and the `/_desktop/` route in the pod.
- `agent-config/scripts/desktop.mjs`, `desktop-browser.sh`, `entrypoint.sh` — the `desktop` command, the browser launcher and boot.
- `frontend/src/api/desktops.ts` — the event stream on the page.
- `frontend/src/components/project/preview/desktop-preview-pane.tsx` — the viewer, keyboard and clipboard.
- `agent-config/skills/agent-browser/SKILL.md` — the handoff the Agent follows.

## Related

- [File preview](file-preview.md) — the panel and switcher the Desktop shares.
- [Request flows](../runtime/request-flows.md) — the ensure gate and activity touches the stream relies on.
- [Test the desktop in an image](../operations/test-the-desktop.md) — running the X11 tests inside a real display.
