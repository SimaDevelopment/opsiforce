---
kind: explanation
terms: [Linked account, Vendor]
---

# Linked account

> How does an admin sign a ChatGPT account in as a Model provider, and what happens when that sign-in ends?

## How it works

- A [Linked account](../../GLOSSARY.md) signs in at a [Vendor](../../GLOSSARY.md), ChatGPT only, instead of taking a key; its requests go through the [Linked-account Proxy](../gateways/linked-account-proxy.md), and its row takes traffic only while it is connected.
- A platform admin signs in `custom-openai-1`, the platform's ChatGPT account, on its Built-in row of the OpenAI card: **Sign in** beside its status shows a panel under its name to open auth.openai.com/codex/device and enter a code like ABCD-1234, with copy buttons and an "expires in" countdown, and the row reads Working by itself. Every Organization's `custom-openai-1` row shares that sign-in ([Opsiforce model provider](opsiforce-model-provider.md)).
- An Organization adds its own on its OpenAI card: the dialog says the ChatGPT account will serve the whole Organization, and `POST /api/model-providers` with `kind: linked-account, vendor: chatgpt, name` creates the Bifrost provider pointing at the proxy with its own random `lap_…` key, and inserts the row switched on for Agents at weight 1 and off for Apps, with a `linked_accounts` row awaiting sign-in; it writes no key, since they leave it out until it is connected. The dialog's button reads **Add and sign in** for a Linked account, and once the provider exists the same dialog turns into its sign-in: it starts the device code by itself, shows the code panel with **Use a Codex access token instead** and **Get a new code** after an expiry or failure, closes itself with a "signed in as" toast once approved, and **Finish later** closes it, leaving the row's own **Sign in** for later. A global `opsiforce-*` Linked account added by a platform admin gets the same step.
- The Organization signs it in the same way with `POST /api/model-providers/<name>/sign-in` and `GET /api/model-providers/<name>/linked-account`, both behind `can_manage_tenant_model_providers`, so any holder can finish or redo a colleague's sign-in. The account is owned by the Organization's own row, so no other Organization's row shares it, and a global `opsiforce-*` Linked account is owned by its platform row and signed in through `/api/platform-model-providers/<name>/…`.
- Its state shows once, in the Status column: **Not signed in** or **Needs sign-in again** while it isn't connected, which also leaves it out of the shares, and Working or Failing once it is. Beside the status is a **Sign in** link (**Sign in again** after OpenAI ended it); under its name are the code panel, the paste form, "Signed in as" the account's email, or the reason OpenAI ended the sign-in; its ⋮ menu has **Sign in with ChatGPT** and **Paste access token** while it isn't connected, Sign in again and Disconnect while it is, and Delete; a missing Linked account is restored by signing in rather than by Re-enter key.
- Under "Signed in as" a Connected account shows its ChatGPT plan's usage limits: a bar per window OpenAI reports, the 5-hour and the weekly one today, with the percent used and when it resets, amber from 75 % and red from 90 %. The page reads `GET …/<name>/linked-account/usage` once a minute, and the backend reads OpenAI's `chatgpt.com/backend-api/wham/usage`, the source of Codex's `/status`, with the account's own token, refreshing it first when it is within 5 minutes of expiry.
- While the code panel is open the page reads the account's status every few seconds; the backend checks with OpenAI at most once every 5 s and only on those reads, waits through a 429, and expires the attempt after 15 minutes. A sign-in never starts or retries by itself.
- On completion the backend first commits the sign-in, with a new `lap_…` key's hash when Bifrost doesn't already serve the provider through the proxy, then points the provider at the proxy with that key and resyncs the Organizations that use it: only the owning Organization for its own Linked account, every Organization for a platform one. The resync is retried three times; when it still fails the request answers 503 asking to sign in again, which reruns it. A repoint that fails after the commit leaves the account connected and its provider where it was, and the boot repoint or another sign-in finishes the move ([Linked-account Proxy](../gateways/linked-account-proxy.md)).
- A Linked account's Bifrost provider takes streaming Responses calls, Chat Completions and image generations and edits, and serves its [Base format](../../GLOSSARY.md)'s catalog plus that format's image models (`gpt-image-2`), so an [App](../../GLOSSARY.md)'s image calls reach the account too ([Linked-account Proxy](../gateways/linked-account-proxy.md)).
- At every boot the backend checks each Connected account's Bifrost provider: one Bifrost no longer serves through the proxy with its `lap_…` key — missing, reset to key-less or to another URL, as a Helm entry change or a Bifrost upgrade does to `custom-openai-1` — is pointed at the proxy again with a new `lap_…` key, and one that lacks any of these request types gets them, and either way the Organizations using it are resynced. A provider with nothing to fix gets no writes, a resync that keeps failing is left to the model catalog check that follows it at boot, and an unreachable Bifrost is retried at the next boot.
- **Paste access token** (`POST …/<name>/access-token`) connects a Business or Enterprise Codex access token (`at-…`) with no device code: the backend checks it with OpenAI's `whoami` and stores it with no refresh token. An `sk-…` value is refused with a pointer to Official API key, and a token `whoami` refuses gets 422.
- **Sign in again** on a Connected account starts a new device code while the old tokens keep serving; the `lap_…` key stays the same, the row stays in the `chat` keys, and the new tokens replace the old ones when the sign-in completes.
- **Disconnect** (`POST …/<name>/disconnect`) revokes the sign-in at OpenAI's `/oauth/revoke` (the refresh token, or a pasted access token), then deletes the credential, then resyncs, so the row leaves the `chat` keys; if OpenAI doesn't answer the revoke the account stays connected and the request fails with 502. On a platform Linked account's Built-in row it is under ⋮ for platform admins, `custom-openai-1` included.
- **Delete** on a Custom or `opsiforce-*` Linked account's row revokes its sign-in the same way before the row, its credential and its Bifrost provider go, and a revoke OpenAI doesn't answer fails the delete with 502 and keeps all three.
- **A sign-in OpenAI has ended** — a refresh answered `refresh_token_reused`, `refresh_token_expired`, `refresh_token_invalidated`, `invalid_grant` or a 401, or a pasted token past its `exp` or refused by `whoami` — has its tokens deleted and the reason kept in `status_reason`, and the Organizations using it are resynced, so the format's other providers that are on take over. Its status reads **Needs sign-in again**, with the reason under its name, until someone signs in or pastes a token.

## Edge cases

- Usage that OpenAI doesn't return answers 502 and the row says it could not be read; the account keeps serving. OpenAI keeps no history, so the bars show only the current window.
- A device code expires after 15 minutes; the row says the last code expired and **Sign in** starts again. An expired re-sign-in leaves the old sign-in Connected.

## Code

- `backend/src/linked-accounts/` — the sign-in, the pasted token, disconnect and the ended sign-in.
- `frontend/src/pages/model-providers/linked-account-sign-in.tsx` — the device-code panel, the pasted-token form and the row states.
- `frontend/src/pages/model-providers/linked-account-usage.tsx` — the usage bars.
- `backend/test/linked-accounts/` — the sign-in, pasted tokens, disconnect, refresh failures and usage against a fake ChatGPT auth server.

## Related

- [Linked-account Proxy](../gateways/linked-account-proxy.md) — the proxy that serves the account and the backend's token refresh.
- [Custom model provider](custom-model-provider.md) — the add dialog it shares with the keyed kinds.
- [Opsiforce model provider](opsiforce-model-provider.md) — the platform providers `custom-openai-1` is one of.
