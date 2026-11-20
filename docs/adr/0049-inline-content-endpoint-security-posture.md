# Inline content endpoint security posture

File preview serves workspace files inline from the app's origin, so the endpoint allow-lists inline disposition (PDF, raster images, inert text, HTML) and serves everything else, SVG and XML included, as an attachment. PDFs render in an un-sandboxed iframe because a sandboxed frame renders nothing in Chromium and Firefox's viewer needs script execution, measured on 2026-08-21 with two frames differing only in the `sandbox` attribute; HTML renders live but every HTML response carries a `Content-Security-Policy` of `sandbox allow-scripts; default-src 'none'` plus inline script, style and `data:`/`blob:` images, so the document lands in an opaque origin and cannot reach cookies, storage, the parent DOM or the platform API even with the session cookie riding along; the backend also refuses every request whose `Origin` is `null`. The trade accepted is that a preview cannot load a CDN library or live data, which is right for a surface whose job is finished files.

## Considered options

- **Sandbox the PDF frame too.** Rejected on measurement: a blank frame, and the exposure a same-origin PDF frame would create is closed by the disposition rules instead.
- **Opaque origin alone for HTML.** Rejected on measurement: a sandboxed probe still fetched the platform API with credentials and read the reply; `default-src 'none'` is what closes it.

## Consequences

- Agent pods cannot call the converter: the agent pods' NetworkPolicy reaches only the services they need, and the converter is not one of them ([ADR-0106](0106-agent-pods-reach-only-the-platform-services-they-call-and-the-internet-and-only-platform-roles-reach-them.md)).
- The endpoint sends `nosniff`, `no-store` and Range support, and shares the path guards and membership check with download.
