# Runnable consumer example

Creates a Project, connects to its Development environment, and talks to the Agent with opencode's own client — the same runtime the app talks to, through the same door.

## The client / runtime pairing

The conversation is the protocol of the deployed build, not a platform-owned contract, so the client and the runtime are pinned together:

| | Version | Where it is pinned |
|---|---|---|
| Runtime | `@opencode-ai/cli@0.0.0-beta-19059` | `docker/Dockerfile.agent` |
| Client | `@opencode-ai/client@0.0.0-beta-19059` | this `package.json` |

Both are published from the same upstream build, so the version strings match exactly. Install it as an ordinary dependency:

```bash
npm install @opencode-ai/client@0.0.0-beta-19059
```

Import `OpenCode` from it and call `OpenCode.make({ baseUrl, fetch })` — that is the whole entry point. Do **not** reach for `@opencode-ai/sdk`: its published `1.18.x` line is a different, older API, and its `create()` starts an *embedded* opencode rather than connecting to a remote one.

When the agent image moves, change both rows together and re-run this example; that is step 4 of [the bump runbook](../../operations/upgrade-opencode.md).

## Running it

```bash
npm install
OPSIFORCE_ORIGIN=https://opsiforce.example.com \
OPSIFORCE_TOKEN="$(your-idp-token-command)" \
npm start
```

Optional: `OPSIFORCE_TENANT` when the caller belongs to more than one Organization, `OPSIFORCE_PROJECT` to reuse a Project instead of creating one, `OPSIFORCE_PROMPT` to change what is asked.

Node 22.6 or newer (the scripts run TypeScript directly with `--experimental-strip-types`).

## Checking it against a runtime

`npm test` runs the adapter against a stub server with Node's own test runner and no extra dependency. It covers what the adapter has to get right: the runtime prefix is restored and never doubled, query strings and bodies survive, the bearer token cannot leak to another origin or follow a redirect, retry guidance is read before the generated client converts the status, and a cancelled stream closes its body.

## What it demonstrates

- **Discovery is origin-relative.** `platform.resolve()` resolves a descriptor URL against the one origin this client was configured with and refuses anything that lands elsewhere, so the bearer token can only ever reach that origin.
- **Connect before chatting.** One call wakes the environment, binds the primary Session and reports the runtime build. It is retried while the answer is "still starting", because that is transient and the call duplicates nothing.
- **The URL adapter.** The generated client builds `new URL(descriptor.path, baseUrl)` with a root-relative path, which discards the `/api/proxy/{environmentId}` prefix (upstream `anomalyco/opencode#46498`). `runtime.ts` puts it back, and only when it is missing, so a retry cannot double it. Query parameters, bodies, cancellation and SSE pass through untouched.
- **Asymmetric retry.** Safe reads and the connection retry on a transient answer, waiting for as long as the server's own `Retry-After` says (both delay-seconds and HTTP-date forms). A prompt is replayed only with its **original id and body**, which the runtime treats as the same admission rather than a second turn. Interrupt and other writes are not retried at all.
- **Cancellation.** One `AbortController` ties the event stream and every call to it, so Ctrl-C ends the run instead of orphaning a stream.

HTTP and SSE are exercised here. WebSocket and PTY compatibility through the proxy is not claimed.
