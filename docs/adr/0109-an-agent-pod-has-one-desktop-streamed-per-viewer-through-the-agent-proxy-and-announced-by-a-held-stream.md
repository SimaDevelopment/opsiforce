# An agent pod has one desktop, streamed per viewer through the agent proxy and announced by a held stream

Every agent pod runs one Xvfb display (`:99`) with Openbox under `guard`, and every process in the pod inherits `DISPLAY`. A small Go manager on `127.0.0.1:6080` lists its windows and starts one x11vnc per viewer, reverse-connected to a loopback listener it owns, so no VNC port ever listens. The browser reaches it as `/api/proxy/<environment-id>/_desktop/…` through the existing agent runtime proxy, which adds a same-origin check for desktop requests, and agent-control routes `/_desktop/` to the manager. The project page learns about windows from a held event stream the manager writes when the window list changes, and shows the desktop as a third mode of the existing preview panel. The agent hands the desktop to the user by asking with the `question` tool.

We chose this because a person sometimes has to use a GUI inside the pod — a sign-in, a consent screen, a CLI login that waits for a `localhost` callback — and the agent proxy already carries project authorization, so the desktop adds no port, Service or host. A held stream is one activity touch at connect, so an open tab lets an idle pod sleep, where polling would keep it awake. The `question` tool keeps the agent's turn paused and lists the Project under Waiting for input, with no new tool.

## Considered options

- **Reserved VNC ports per session.** Rejected: each needs its own Service and authentication, and the proxy route already has both.
- **Polling the window list.** Rejected: every agent-proxy request touches activity, so a visible tab would keep the pod running forever.
- **Independent side-by-side panels for the App, each file, the desktop and each window.** Deferred: it replaces the panel the phone layout is built on, and is a product change of its own.
- **WebRTC streaming.** Rejected for now: it needs UDP or TURN through the ingress, and sign-in forms do not need video frame rates.

## Consequences

- One desktop per pod: every member who opens the Project and every chat session in it see and can type into the same desktop. Control is cooperative, not enforced.
- Ctrl, Cmd and Alt combinations typed into the viewer are sent to the desktop by a window-level capture listener, because the chat's shortcut listener sits on the document and would otherwise take them.
- GUI memory counts against the agent container's limit; a heavy page can push the pod towards its limit.
- Existing pods get the desktop when their pod is next recreated; the skill tells the user to restart the project meanwhile.
