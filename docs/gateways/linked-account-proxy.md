---
kind: explanation
adrs: [0018]
---

# Linked-account Proxy

> How do requests reach a signed-in ChatGPT account, and who keeps its tokens?

## How it works

- `linked-account-proxy` is a stateless Deployment in the cluster, one replica by default, that Bifrost reaches at `http://opsiforce-linked-account-proxy:8455/v1` for every [Linked account](../../CONTEXT.md); it is built from Node built-ins only and holds nothing but a token cache ([ADR-0018](../adr/0018-linked-account-traffic-goes-through-a-stateless-in-cluster-proxy.md)).
- The backend owns every token: the `linked-accounts` module signs the account in, keeps the encrypted credential in `linked_accounts` on the owning Model provider row, and refreshes it on demand under `SELECT … FOR UPDATE`, only within 5 minutes of expiry, saving the rotated tokens.
- On completion the backend writes a random `lap_…` secret as the provider's Bifrost key, keeps only its hash, points the provider's `base_url` at the proxy's Service URL with `allow_private_network: true`, and resyncs the Organizations that use it ([Linked account](../organization/linked-account.md)). When the provider is missing from Bifrost, or `custom-openai-1` has no platform row yet, the sign-in creates them.
- For a pasted access token, which has no refresh token, the credential route asks OpenAI's `whoami` again on every read, which gives the proxy the account id, and a token past its `exp` or refused by `whoami` counts as ended.
- A sign-in OpenAI has ended has its tokens deleted and every Organization using it resynced ([Linked account](../organization/linked-account.md)), and the credential route answers 409 until someone signs in again.
- A Vendor 5xx or a timeout on a refresh or `whoami` is transient: the tokens are kept and only that credential request fails with 502.
- A provider pointing at the proxy is in an Organization's `chat` keys only while its account is connected; one still pointing elsewhere is not a Linked account yet, so `custom-openai-1` keeps serving from its old upstream until its sign-in completes.
- Bifrost calls the proxy with the `lap_…` key as its bearer token. The proxy resolves it through the backend's `POST /api/internal/linked-accounts/credential`, sending its service token from its Secret (`opsiforce-linked-account-proxy-service-token` in development, production and standalone installs, the chart's own `opsiforce-linked-account-proxy-secret` locally), and gets back `{vendor, accessToken, accountId, expiresAt}`; the backend's `LINKED_ACCOUNT_PROXY_SERVICE_TOKEN` carries the same value.
- The proxy caches the token until 5 minutes before `exp`, so a short backend outage doesn't stop inference, and on an upstream 401 it asks once more with `force_refresh` and retries once.
- `POST /v1/responses` forwards to ChatGPT with the account's bearer token, `chatgpt-account-id` and `originator: codex_cli_rs`; the caller's own key never reaches upstream. The body is rewritten on the way: `instructions` defaults to `""`, `store` defaults to `false`, `stream` is always `true` and `max_output_tokens` is dropped.
- A streaming caller gets the SSE response passed through as it arrives; a caller that doesn't stream gets the completed response, buffered from the stream. An upstream error comes back with its status, content type and body text unchanged.
- `GET /v1/models` answers the adapter's fixed ChatGPT list in OpenAI list shape, with no call to ChatGPT; `GET /healthz` is the liveness check.
- Tilt builds the image from `docker/Dockerfile.linked-account-proxy` and deploys the `opsiforce-linked-account-proxy` chart in the local cluster, so local routing matches production; the deploy workflow ships the same chart to development and production with `values.<env>.yaml`, and a standalone install deployed with the Helm charts uses `values.standalone.yaml`, one replica each ([Deployment](../operations/deployment.md)).

## Edge cases

- A request without a `lap_…` key, or with one the backend doesn't know, gets 401 and never reaches ChatGPT.
- A request that relies on server-side replay state (`previous_response_id` or an `item_reference` input) is refused with 400, since the proxy is stateless.
- A request body over the cap (64 MiB) is refused with 413 when its declared length is over; a chunked body that grows past the cap has its connection dropped.
- When the backend can't be reached and no token is cached, the proxy answers 502 and Bifrost fails over to the format's other providers.
- ChatGPT exposes no audio endpoint, so [Dictation](../projects/dictation.md) needs the built-in `openai` key.

## Code

- `backend/src/linked-accounts/` — the credential route, the refresh, and the ChatGPT adapter's backend half.
- `linked-account-proxy/src/` — the HTTP server, caller auth, the token cache and the body cap.
- `linked-account-proxy/src/chatgpt/` — the ChatGPT forward and its fixed model list.
- `helm/opsiforce-linked-account-proxy/` — the chart.
- `docker/Dockerfile.linked-account-proxy` — the image.
- `linked-account-proxy/test/` — the proxy against a fake backend and a fake ChatGPT upstream.

## Related

- [LLM Gateway](llm-gateway.md) — the provider routing that sends Linked-account traffic here.
- [Linked account](../organization/linked-account.md) — the sign-in, pasted tokens, Sign in again and Disconnect.
- [Quickstart](../operations/quickstart.md) — where a standalone operator signs ChatGPT in.
- [Local orchestration](../operations/local-orchestration.md) — the proxy as an in-cluster Tilt resource.
