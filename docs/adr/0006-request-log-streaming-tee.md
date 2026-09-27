# Request-log body capture streams and tees a bounded prefix; verbosity is a separate per-project policy

The app-mode runtime proxy captures request/response bodies for its per-project log by **streaming the response to the client while tee-ing only the first N bytes** into the log (a bounded `capturingReader`), and truncates **at capture time**, not at write time. Body capture is gated by a per-Project **logging level** — Off / Metadata / Full — and **Full is the default**, so existing projects are unchanged. We removed the prior branch that ran `io.ReadAll` on any `text/*` or unknown-length response purely to populate the log.

We chose this because the original design buffered whole bodies in memory *solely for logging*. Since `text/event-stream` reports no `Content-Length`, LLM streams were buffered to completion before the client saw a byte — breaking streaming and stacking full in-memory copies under concurrency (the "hundreds of requests in parallel" backup into Bifrost). Tee-ing a bounded prefix fixes the *mechanism*: memory per request is bounded by the byte limit regardless of body size, and streaming is preserved at every level. That **decouples the incident (a buffering bug) from verbosity (a policy knob)** — which is why Full can remain the default (it is now safe) while Metadata/Off exist for projects that want less.

## Considered options

- **Drop the default to Metadata/Off to stop the incident** — rejected as the primary fix: it treats a mechanism bug as a policy problem, leaves the buffering landmine for any project on Full, and silently removes body logging people rely on.
- **Buffer-then-truncate at write time** (keep the `io.ReadAll`, cap inside the logger) — rejected: still buffers the whole body in the hot path (the actual cost) and still defeats streaming; a write-time cap bounds what is *stored*, not what is *held in memory*.
- **Join the two-tier (global→tenant) defaults system** for logging — deferred: the realistic adjustment is per-project, defaults only seed *new* projects (no relief for the existing heavy ones), and it adds tables/UI/permissions for no incident benefit.

## Consequences

- Even at Full, the per-project log holds at most a bounded prefix of each body; full payloads can never be reconstructed from the log.
- Worst-case proxy memory for queued log entries is `queueDepth × (request prefix + response prefix)` — bounded by the body-limit **ceiling (3 MB; default 256 KB)**, the single lever that caps the shared proxy's exposure. Raising the ceiling raises that exposure proportionally (`queueDepth` is the other factor), so it trades shared-proxy memory headroom for log completeness.
- Two `io.ReadAll` paths remain for **non-logging** reasons (error responses, for pod-error detection; HTML, for upstream-path rewriting) and are bounded by response type.
- A nil/absent logging policy from the control plane falls back to Full, so an older backend or a non-app surface behaves exactly as before.
- Sensitive headers (credentials and session material, including `x-proxy-control-token`) are redacted before any header set is written to the log; end-user identity headers are left visible as debugging signal.
