# Runnable consumer example

Creates a Project, connects to its Development environment, and talks to the Agent with opencode's own client — the same runtime the app talks to, through the same door.

## The client / runtime pairing

The conversation is the protocol of the deployed build, not a platform-owned contract, so the client and the runtime are pinned together:

| | Version | Where it is pinned |
|---|---|---|
| Runtime | `@opencode/cli@2.1.2` | `docker/Dockerfile.agent` |
| Client | `@opencode/client@2.1.2` | this `package.json` |

Both are published from the same upstream release, so the version strings match exactly, and `connect` reports the same string as `build`. Install it as an ordinary dependency:

```bash
npm install @opencode/client@2.1.2
```

Import `OpenCode` from it and call `OpenCode.make({ baseUrl, fetch })` — that is the whole entry point. `baseUrl` is the resolved `/api/proxy/{environmentId}` URL as `connect` returned it; the client keeps that prefix. Do **not** reach for `@opencode/sdk`: it hosts an *embedded* opencode in your process rather than connecting to a remote one.

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

`npm test` runs the example against a stub server with Node's own test runner and no extra dependency. It covers what the example has to get right: native prompts go out authenticated under the runtime prefix, a prompt's outcome is read from its own delivery and the outcome event after it (not from an earlier turn or another Session), an ambiguous admission is replayed with the same id and body, cancelling stops the wait, the bearer token cannot leak to another origin or follow a redirect, and retry guidance is read before the generated client converts the status.

## Learning a prompt's outcome

`runtime.ts` follows the event recipe in [Connection](../connection.md#then-it-is-opencode). `POST /api/experimental/session/{sessionID}/wait` (`session.wait` in the client) is an experimental shortcut that returns once the Session is idle, which is not your prompt's outcome.

## What it demonstrates

- **Discovery is origin-relative.** `platform.resolve()` resolves a descriptor URL against the one origin this client was configured with and refuses anything that lands elsewhere, so the bearer token can only ever reach that origin.
- **Connect before chatting.** One call wakes the environment, binds the primary Session and reports the runtime build. It is retried while the answer is "still starting", because that is transient and the call duplicates nothing.
- **The client's `fetch` is the platform's.** Every runtime call goes through `Platform.fetch`, which adds the bearer token, refuses other origins and redirects, and retries safe reads on a transient answer. Query parameters, bodies, cancellation and SSE pass through untouched.
- **The event recipe.** `promptForOutcome()` subscribes first, prompts with its own id, and reports the outcome event that follows that prompt's delivery.
- **Asymmetric retry.** Safe reads and the connection retry on a transient answer, waiting for as long as the server's own `Retry-After` says (both delay-seconds and HTTP-date forms). A prompt is replayed only with its **original id and body**, which the runtime treats as the same admission rather than a second turn. Interrupt and other writes are not retried at all.
- **Cancellation.** One `AbortController` ties the event stream and every call to it, so Ctrl-C ends the run instead of orphaning a stream.

HTTP and SSE are exercised here. WebSocket and PTY compatibility through the proxy is not claimed.
