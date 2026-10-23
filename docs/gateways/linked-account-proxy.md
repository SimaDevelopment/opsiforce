---
kind: explanation
adrs: [0018]
---

# Linked-account Proxy

> How do requests reach a signed-in ChatGPT account, and who keeps its tokens?

## How it works

- `linked-account-proxy` is a stateless Deployment in the cluster, one replica by default, that Bifrost reaches at `http://opsiforce-linked-account-proxy:8455/v1` for every [Linked account](../../GLOSSARY.md); it is built from Node built-ins only and holds nothing but a token cache ([ADR-0018](../adr/0018-linked-account-traffic-goes-through-a-stateless-in-cluster-proxy.md)).
- The backend owns every token: the `linked-accounts` module signs the account in, keeps the credential in `linked_accounts` on the owning Model provider row, sealed with `EXTERNAL_SERVICES_ENCRYPTION_KEY` and bound to that row (`linked_accounts|<modelProviderId>|credential`, [ADR-0080](../adr/0080-built-in-vendor-settings-live-in-service-configuration-and-sealed-secrets-are-bound-to-their-place.md)), and refreshes it on demand under `SELECT … FOR UPDATE`, only within 5 minutes of expiry, saving the rotated tokens.
- On completion the backend writes a random `lap_…` secret as the provider's Bifrost key, keeps only its hash, points the provider's `base_url` at the proxy's Service URL with `allow_private_network: true`, and resyncs the Organizations that use it ([Linked account](../organization/linked-account.md)). When the provider is missing from Bifrost, or `custom-openai-1` has no platform row yet, the sign-in creates them.
- For a pasted access token, which has no refresh token, the credential route asks OpenAI's `whoami` again on every read, which gives the proxy the account id, and a token past its `exp` or refused by `whoami` counts as ended.
- A sign-in OpenAI has ended has its tokens deleted and every Organization using it resynced ([Linked account](../organization/linked-account.md)), and the credential route answers 409 until someone signs in again.
- A Vendor 5xx or a timeout on a refresh or `whoami` is transient: the tokens are kept and only that credential request fails with 502.
- A provider pointing at the proxy is in an Organization's `chat` keys only while its account is connected; one still pointing elsewhere is not a Linked account yet, so `custom-openai-1` keeps serving from its old upstream until its sign-in completes.
- Bifrost calls the proxy with the `lap_…` key as its bearer token. The proxy resolves it through the backend's `POST /api/internal/linked-accounts/credential`, sending its service token from its Secret (`opsiforce-linked-account-proxy-service-token` in development, production and standalone installs, the chart's own `opsiforce-linked-account-proxy-secret` locally), and gets back `{vendor, accessToken, accountId, expiresAt}`; the backend's `LINKED_ACCOUNT_PROXY_SERVICE_TOKEN` carries the same value.
- The proxy caches the token until 5 minutes before `exp`, so a short backend outage doesn't stop inference, and on an upstream 401 it asks once more with `force_refresh` and retries once.
- `POST /v1/responses` forwards to ChatGPT with the account's bearer token, `chatgpt-account-id` and `originator: codex_cli_rs`, never the caller's key, after defaulting `instructions` to `""` and `store` to `false`, forcing `stream: true` and dropping the fields ChatGPT refuses, such as `max_output_tokens`, `temperature` and `metadata`. A streaming caller gets the SSE response passed through as it arrives, and any other caller the completed response buffered from the stream, or an HTTP error when the stream fails or ends before the response completes.
- ChatGPT keeps its prompt cache per `session-id` header, which the proxy sets from the body's `prompt_cache_key`. A caller that sends none gets one derived from how the conversation starts (model, reasoning effort, instructions, tool names and the first input item), so the later turns of a conversation and the repeats of an App's call share a cache.
- `POST /v1/chat/completions` becomes the same streamed ChatGPT call: the text of every `system` message moves into `instructions`, and all other messages, `developer` ones included, become Responses input items, tool calls and results included. A `system` message also stays in the input as a `developer` message when the call asks for `response_format: json_object`, because ChatGPT then requires the word "json" in an input message and ignores `instructions` for that check, and when it carries an image or a file, which ChatGPT then rejects, as OpenAI does: system and developer messages take only text. Function tools are flattened with `strict` off unless the caller set it, and `response_format` and `reasoning_effort` map to `text.format` and `reasoning.effort`. The answer comes back as `chat.completion.chunk` events to a streaming caller, ending in `[DONE]` only once the response completes and with a usage chunk when `stream_options.include_usage` is set, and as one `chat.completion` otherwise; Bifrost sends a Linked account's non-streaming Responses calls here too, so every call shape reaches the account.
- ChatGPT often refuses a request inside a 200 stream, so on every route the proxy holds the stream until its first event past `response.created` / `response.in_progress` and turns an `error` or `response.failed` there, or an end before any such event, into an HTTP error with an OpenAI-shaped `{error}` body: 429 for a rate or usage limit, 502 for a server failure, an overload, an early end or a `response.completed` with neither output nor usage, and 400 for anything else. Bifrost can only retry or fail over on a real status, and retries a 400 naming encrypted reasoning once with the replayed reasoning stripped; an error after output has started stays in the stream.
- `POST /v1/images/generations` and `POST /v1/images/edits` (form data: `image` or `image[]`, optional `mask`) become one streamed ChatGPT call per requested image, run in parallel, each forcing the `image_generation` tool on `gpt-5.6-luna` with the caller's image model and options and the uploads as data URLs. The images come back together in the Images API shape as `b64_json`, ChatGPT may pick its own size, and one call that fails, or completes without an image (502), fails the request.
- `GET /v1/models` answers the adapter's fixed ChatGPT list in OpenAI list shape, with no call to ChatGPT; `GET /healthz` is the liveness check. Any other path answers 404.
- Tilt builds the image from `docker/Dockerfile.linked-account-proxy` and deploys the `opsiforce-linked-account-proxy` chart in the local cluster, so local routing matches production; the deploy workflow ships the same chart to development and production with `values.<env>.yaml`, and a standalone install deployed with the Helm charts uses `values.standalone.yaml`, one replica each ([Deployment](../operations/deployment.md)).

## Edge cases

- A request without a `lap_…` key, or with one the backend doesn't know, gets 401 and never reaches ChatGPT.
- A request that relies on server-side replay state (`previous_response_id` or an `item_reference` input) is refused with 400, since the proxy is stateless.
- A request the proxy cannot convert (more than one Chat Completions choice, audio input, an unknown content part, or an image `n` outside 1 to 10) is refused with 400 without calling ChatGPT.
- When ChatGPT answers with an HTTP error, the caller gets its status, content type and body text unchanged, except that a 400 saying the model is at capacity or that an error occurred while processing the request becomes 502.
- A request body over the cap (64 MiB) is refused with 413 when its declared length is over; a chunked body that grows past the cap has its connection dropped.
- A credential copied onto another row does not open there: the credential route answers 500 and logs the row, and that account serves nothing until it signs in again. Credentials sealed before this binding are re-sealed to their row once, at backend boot.
- When the backend can't be reached and no token is cached, the proxy answers 502 and Bifrost fails over to the format's other providers.
- ChatGPT exposes no audio endpoint, so [Dictation](../projects/dictation.md) needs the built-in `openai` key.

## Code

- `backend/src/linked-accounts/` — the credential route, the refresh, and the ChatGPT adapter's backend half.
- `backend/src/sealing/` — sealing and opening a secret bound to its place.
- `linked-account-proxy/src/` — the HTTP server, caller auth, the token cache, the body cap, and the Chat Completions and Images conversions.
- `linked-account-proxy/src/chatgpt/` — the ChatGPT call, its stream checks, the forward of each route and the fixed model list.
- `helm/opsiforce-linked-account-proxy/` — the chart.
- `docker/Dockerfile.linked-account-proxy` — the image.
- `linked-account-proxy/test/` — the proxy against a fake backend and a fake ChatGPT upstream.

## Related

- [LLM Gateway](llm-gateway.md) — the provider routing that sends Linked-account traffic here.
- [Linked account](../organization/linked-account.md) — the sign-in, pasted tokens, Sign in again and Disconnect.
- [Quickstart](../operations/quickstart.md) — where a standalone operator signs ChatGPT in.
- [Local orchestration](../operations/local-orchestration.md) — the proxy as an in-cluster Tilt resource.
