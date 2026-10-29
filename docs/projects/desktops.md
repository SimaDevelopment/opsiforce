# Agent desktops

An agent environment has one lightweight Xvfb display (`DISPLAY=:99`) available to the agent and its child processes. Openbox manages its windows on a single virtual workspace. Headed GUI apps appear automatically in the project's preview panels; an empty default desktop remains hidden. There is no separate desktop container and no desktop environment such as GNOME running in the background.

All GUI apps share this one desktop, including apps launched by child agents. An individual-window panel is another view of that same desktop. Up to 10 VNC viewers can connect at once; no additional X11 desktops can be created. The agent selects a whole-desktop or window view with:

```sh
desktop list
desktop show
desktop show 0x00400003
```

Use a current window ID from `desktop list`. The desktop and GUI processes are ephemeral and end when the pod stops. Workspace files follow the existing storage lifecycle.

## Preview behavior

App, file, desktop and individual-window previews have independent side-by-side panels. Each panel can be resized or collapsed without rearranging the others; the workspace scrolls horizontally when needed. Opening a window from the desktop picker adds a separate view of that window on the same display. Opening another file preserves earlier file panels. Desktop panels offer a whole-desktop/window selector, full screen and automatic reconnection. Input starts when the user clicks inside the viewer; there is no separate control button. Before that click the client suppresses input. The authenticated connection permits interaction, so this is a UX affordance, not an authorization boundary.

Collapsing or scrolling a desktop panel out of view disconnects its viewer and stops its VNC process; the app continues running. Closing a window preview does not close its app. The shared display stays available for agent children. GUI apps continue consuming their own memory while hidden.

The agent-browser skill explains headed mode and handoff: the agent presents a view and pauses automation while the user interacts, then resumes the same browser session. This is a cooperative handoff, not a lock preventing an agent process from sending input.

Selected-window capture uses x11vnc's `-id` mode. Overlapping or minimized windows can produce blank or stale content; keep the target window visible. Separate dialogs, menus and other windows may require the whole-desktop view. It is a viewing choice, not an isolation boundary between apps within one environment.

## Clipboard

Text clipboard sharing supports Ctrl/Cmd+C, X and V, including multiline text, Hebrew and emoji. macOS copy/paste shortcuts map to Linux shortcuts; Ctrl+Shift+C/V is preserved for terminals. Only the visible, actively focused desktop view synchronizes remote copies back to the computer. Opening a view establishes a baseline without replacing the host clipboard. The app never polls or uploads the host clipboard; text is sent only when the user pastes.

The Clipboard button provides a text box and explicit transfer controls when browser permissions prevent automatic access. Firefox and Safari may require a user gesture for clipboard writes or show a prompt when reading via the button. Native keyboard paste uses the browser's paste event and does not need background clipboard-read access. Images and files are not transferred.

UTF-8 clipboard text travels through `GET`/`PUT /api/proxy/<environment-id>/_desktop/clipboard`, using the same project authorization and origin checks as VNC. Agent-control uses `xclip` on `:99`; it limits clipboard text to 1 MiB and times out clipboard operations after two seconds. Legacy VNC selection exchange remains disabled to avoid Latin-1 corruption. The focused view checks for app-menu copies once per second; keyboard Copy/Cut requests a prompt refresh. Clipboard contents are not logged or saved by the proxy.

## Transport and authorization

Agent pods mount a private, memory-backed `emptyDir` at `/dev/shm`, capped at 512 MiB. This replaces the container runtime's 64 MiB default for Chromium and Electron shared memory. Pages are allocated as used and count toward the existing agent memory limit; the cap does not reserve extra RAM. The same pod configuration applies to the default and Kata runtimes. Existing pods receive the mount when recreated; restarting an app inside an existing pod does not change its mounts. The desktop browser launcher uses this shared memory directly, without `--disable-dev-shm-usage`.

The frontend uses noVNC over `wss://<opsiforce>/api/proxy/<environment-id>/_desktop/sessions/<session-id>/connect`. The existing agent runtime proxy performs project authorization and activity tracking, then forwards to the agent's existing HTTP endpoint. An additional origin check rejects cross-site desktop requests and WebSocket upgrades. Agent-control routes `/_desktop/` to the pod-local desktop manager on `127.0.0.1:6080`.

Each viewer starts x11vnc with a reverse connection to an ephemeral loopback listener. X11 TCP listening and x11vnc command/file-transfer facilities are not enabled. No public per-session ports, Kubernetes Services, additional ingress hostnames, or registry are needed. VNC traffic is carried on the authenticated Opsiforce HTTPS connection. Do not expose the pod's agent HTTP port directly outside the cluster; it relies on the existing runtime proxy trust boundary.

The manager tracks owned child processes and stops them when a viewer/session ends. Its supervisor restarts it if an X server or window manager fails. Session metadata is held in memory. Installed GUI packages increase image size on disk; the idle runtime consists of Xvfb, Openbox and the small Go manager. VNC encoding runs only while a view is connected.

## Validation

Proxy tests cover cross-project authorization and cross-origin requests. Desktop tests cover single-desktop enforcement, rejected lifecycle requests and the viewer cap. The X11 integration test runs inside the agent image and checks actual window discovery plus RFB handshakes for both a whole desktop and a cropped window:

```sh
cd packages/opsiforce/proxy
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go test -c -o /tmp/desktop.test ./internal/desktop
docker run --rm --entrypoint /tmp/desktop.test \
  -v /tmp/desktop.test:/tmp/desktop.test:ro opsiforce-agent:0.48.0 -test.v
```

Use the architecture of the agent image when compiling the test binary. Existing agent pods need the new agent image before desktop features become available.

### Claude Desktop smoke test

Claude Desktop can be installed in a disposable agent pod from [Anthropic's official Linux apt repository](https://support.claude.com/en/articles/10065433-install-claude-desktop). It is not included in the base agent image. The local test used the official arm64 package, version 4.29.0, on Debian 12.

Launch on `DISPLAY=:99`, alongside a headed Chromium session. The current agent runs as root, so Electron requires `claude-desktop --no-sandbox` within this test container. On the older test pod with a 64 MiB `/dev/shm`, restarting with `--disable-dev-shm-usage` resolved Electron `ERR_INSUFFICIENT_RESOURCES` failures after sign-in. New pods have the larger mount; Chromium rendering without this workaround has been verified, but authenticated Claude still needs to be retested without it. For browser sign-in callbacks, copy `/usr/share/applications/com.anthropic.Claude.desktop` into `${XDG_DATA_HOME:-$HOME/.local/share}/applications/` and add the same launch flags to its `Exec=claude-desktop` entries. Register it with `xdg-mime default com.anthropic.Claude.desktop x-scheme-handler/claude`. This is needed only for this root-based test installation. Use `desktop list` to find Claude's window and `desktop show WINDOW_ID` to present it. Confirm that the same app appears in the whole-desktop view and the separate window panel, and that clicking Get started reaches sign-in. Leave account authentication to the user. After the user completed sign-in, the authenticated Claude home loaded in both views. No Chat, Code or Cowork task was submitted. The minimal image has no desktop keyring; Claude reports that its OAuth token cache will not persist through safeStorage.

External HTTP/HTTPS links use the desktop Chromium launcher on the same display. It supplies the container-required `--no-sandbox` flag only when running as root; otherwise Chromium retains its sandbox. This also allows desktop apps to open browser-based sign-in flows.

When launching apps with `kubectl exec`, explicitly pass `DISPLAY=:99`: exec does not inherit environment variables exported by the entrypoint. Normal agent children inherit it automatically.
