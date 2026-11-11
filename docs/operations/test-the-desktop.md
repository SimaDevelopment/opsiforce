---
kind: operations
---

# Test the desktop in an image

> Run the desktop manager's tests against a real X11 display and VNC server.

## Prerequisites

- Docker, and the agent image built for your machine's architecture (or any Debian image with `xvfb x11vnc openbox wmctrl x11-utils xterm xclip`).

## Steps

1. From `packages/opsiforce/proxy`, build the test binary for the image's architecture: `CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go test -c -o /tmp/desktop.test ./internal/desktop`.
2. Run it inside the image: `docker run --rm --entrypoint /tmp/desktop.test -v /tmp/desktop.test:/tmp/desktop.test:ro opsiforce-agent:$(jq -r .version ../agent-config/agent-image-version.json) -test.v`.
3. To try GUI apps by hand in a running pod, pass `DISPLAY=:99` to `kubectl exec`, which does not inherit the entrypoint's environment.

## Verify

- `TestX11DesktopAndWindowStreaming` passes: it finds a real window and completes RFB handshakes for the whole desktop and the cropped window.
