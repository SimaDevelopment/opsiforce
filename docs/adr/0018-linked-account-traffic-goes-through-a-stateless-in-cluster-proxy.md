# Linked-account traffic goes through a stateless in-cluster proxy, and the backend owns every token

A Linked account is a Model provider whose credential is a signed-in account at a Vendor, ChatGPT first. Bifrost can't call ChatGPT's Codex backend itself: the request needs the account's bearer token, its `chatgpt-account-id` and a rewritten body, and the token has to be refreshed with a rotating refresh token that dies when it is spent twice.

**Bifrost sends every Linked account's requests to `linked-account-proxy`, a stateless Deployment at `http://opsiforce-linked-account-proxy:8455/v1`, and the backend owns each account's sign-in, tokens and refresh.**

- **The backend owns the tokens.** Sign-in, storage and refresh run in the backend's `linked-accounts` module. The `linked_accounts` row hangs off the owning `model_providers` row and keeps the encrypted credential, the encrypted pending sign-in, the reason a sign-in stopped working and the hash of the caller secret. Expiry, the account id, the "Signed in as" label and device-vs-pasted are read from the token when needed and never stored.
- **Refresh is on demand and single-writer.** The backend refreshes under `SELECT … FOR UPDATE` on the account's row: it reloads inside the lock, refreshes only when the token expires within 5 minutes or the proxy asks for `force_refresh`, and saves the rotated tokens before it answers. Concurrent callers across backend replicas wait on the row and get the token the first one saved. There is no timer.
- **Device sign-in is explicit and throttled.** A sign-in starts only when someone clicks, and never retries by itself. The backend checks with the Vendor at most once every 5 s, under the row lock, and only while someone reads that account's status; a 429 waits instead of failing, and the attempt expires after 15 minutes.
- **The caller is its Bifrost key.** Each Linked account gets a random `lap_…` secret when it first connects, and keeps it when it is signed in again, so switching accounts has no gap. The secret is the key value of its Bifrost provider, the only copy, and the row keeps its hash, compared timing-safely. Bifrost sends only the key value, so the key value is the one way to tell which account a request is for.
- **The proxy fetches tokens from the backend.** It resolves a `lap_…` key through `POST /api/internal/linked-accounts/credential`, which takes the proxy's service token from a Kubernetes Secret and answers `{vendor, accessToken, accountId, expiresAt}`. An unknown key gets a 401. The proxy caches the token until 5 minutes before `exp`, so the backend is asked about once an hour per account, and on an upstream 401 it retries once with `force_refresh`.
- **Completing a sign-in is the switch.** On completion the backend writes the `lap_…` key and the proxy's Service URL, with `allow_private_network: true`, into the account's Bifrost provider, creating the provider through the shared create code when it is missing, and resyncs every Organization using it. A provider that points at the proxy takes traffic only while its account is connected; one that doesn't is not a Linked account yet, so `custom-openai-1` keeps serving from its old upstream during the sign-in that moves it.
- **An ended sign-in leaves traffic by itself.** A refresh OpenAI refuses for good (`refresh_token_reused`, `_expired`, `_invalidated`, `invalid_grant`, a 401) or an ended pasted `at-…` token deletes the tokens, keeps the reason and resyncs, and the row reads Needs sign-in again; a Vendor 5xx keeps the tokens and fails only that request. Disconnect revokes at the Vendor before it deletes anything.
- **`custom-openai-1` is the platform's Linked account.** Its owner is the platform row, every Organization's `custom-openai-1` row shares that sign-in, and a platform admin signs it in on the Built-in card. It is never seeded from env, and there is no terminal login.
- **The Vendor adapter has two halves.** The backend half starts and polls the sign-in, refreshes, checks a pasted access token with `whoami`, revokes and describes the account; the proxy half forwards. A new Vendor is one adapter with no new table, route or service. Nothing Codex-specific appears outside the ChatGPT adapter.

## Considered options

- **The proxy owns the tokens in its own database.** Rejected: it needs a second encryption key, migrations and an admin API for the sign-in, where the backend already has all three.
- **The backend pushes access tokens into Bifrost on a timer.** Rejected: a missed hourly run is an outage for every Organization the account serves.
- **A backend route instead of a separate service.** Rejected: model streams run for minutes, and a backend deploy or a live-sync restart would cut them.
- **A NetworkPolicy around the proxy.** Rejected: the `lap_…` secret already authenticates every caller, and no other Opsiforce service has one.

## Consequences

- **It rides an unofficial surface.** Sign-in uses the Codex CLI's `client_id` against `auth.openai.com`, and requests go to `chatgpt.com/backend-api/codex` with `originator: codex_cli_rs`. The endpoint can change without notice. OpenAI's documentation doesn't cover a ChatGPT token kept on Opsiforce's infrastructure and used for an Organization, and `custom-openai-1` serves every Organization; the owner accepts both risks.
- **Streams survive backend deploys, and a short backend outage doesn't stop inference**, because the proxy holds no state beyond its token cache and keeps serving the cached token.
- **The proxy is one replica by default.** It is stateless, so scaling it is a values change, and a restart loses only its cache.
- **`GET /v1/models` is the adapter's fixed list.** There is no live model fetch; a model ChatGPT stops serving fails over like any upstream error.
