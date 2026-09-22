# Inline content endpoint security posture

File preview serves workspace files inline from the app's origin, so the endpoint allow-lists inline disposition (PDF, raster images, inert text, HTML) and serves everything else, SVG and XML included, as an attachment. PDFs render in an un-sandboxed iframe because a sandboxed frame renders nothing in Chromium and Firefox's viewer needs script execution, measured on 2026-08-21 with two frames differing only in the `sandbox` attribute; HTML renders live but every HTML response carries a `Content-Security-Policy` of `sandbox allow-scripts; default-src 'none'` plus inline script, style and `data:`/`blob:` images, so the document lands in an opaque origin and cannot reach cookies, storage, the parent DOM or the platform API even with the session cookie riding along. The trade accepted is that a preview cannot load a CDN library or live data, which is right for a surface whose job is finished files.

## Considered options

- **Sandbox the PDF frame too.** Rejected on measurement: a blank frame, and the exposure a same-origin PDF frame would create is closed by the disposition rules instead.
- **Opaque origin alone for HTML.** Rejected on measurement: a sandboxed probe still fetched the platform API with credentials and read the reply; `default-src 'none'` is what closes it.

## Consequences

- A NetworkPolicy blocking agent pods from calling the converter directly was consciously deferred on 2026-08-21: agent pods share the namespace and can submit conversions, the realistic exposure is queue starvation rather than data access, and minikube's default CNI enforces no policy, so an unverifiable object was not shipped. The fix, if abuse appears, is a namespaced NetworkPolicy plus a CNI check.
- The endpoint sends `nosniff`, `no-store` and Range support, and shares the path guards and membership check with download.
