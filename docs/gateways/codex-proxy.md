---
kind: explanation
adrs: [0018]
---

# Codex Proxy

> How does the standalone local stack reach an LLM through a ChatGPT or Codex subscription?

## How it works

- The codex proxy is a dependency-light TypeScript server in the `codex-proxy/` workspace, built from Node built-ins only, that runs on the developer's host because it needs a browser login and reaches OpenAI directly ([ADR-0018](../adr/0018-standalone-llm-access-via-codex-proxy.md)).
- Its only caller is Bifrost: in the standalone stack the custom providers point their `base_url` at the proxy over `host.minikube.internal`, so to the [LLM Gateway](llm-gateway.md) it is just an OpenAI endpoint and the Agent's default model, `openai/gpt-5.6-sol`, is unchanged.
- `GET /v1/models` returns the subscription's catalogue in OpenAI list shape, so the gateway and the Quickstart's first-run check can see that the default model is available.
- `POST /v1/responses` forwards the request body untouched, swaps in the subscription's bearer token and account id, and streams the SSE response back; the caller's own authorization header never reaches upstream and the real token never reaches the caller.
- Authentication is a device-code login against `auth.openai.com` run once by the proxy's `login` command during the [Quickstart](../operations/quickstart.md); tokens are written with owner-only permissions to `~/.opsiforce/codex-auth.json`, outside the repo.
- Before every forwarded call the proxy checks token expiry and refreshes in place, collapsing concurrent refreshes into one; `GET /healthz` is the liveness check for the process orchestrator.
- The upstream is the Codex CLI's own backend, authenticated with its client id, and is unofficial; the bring-your-own-key Quickstart option is the alternative when it breaks.

## Edge cases

- When no token is present, `/v1/responses` answers 401 telling the operator to run the login.
- When the Quickstart runs with `--reset`, the stored login is cleared to exercise a fresh first run.
- The subscription upstream exposes no audio endpoint, so [Dictation](../projects/dictation.md) is disabled on this path.

## Code

- `codex-proxy/src/` — config, the OAuth device flow, token refresh and the HTTP server.

## Related

- [LLM Gateway](llm-gateway.md) — the custom providers and the egress that reach this proxy.
- [Quickstart](../operations/quickstart.md) — the LLM step that runs the login.
- [Local orchestration](../operations/local-orchestration.md) — the proxy as a host-side Tilt resource.
