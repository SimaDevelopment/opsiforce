---
kind: explanation
terms: [Dictation]
adrs: [0045]
---

# Dictation

> How does speech from the mic button become text in the prompt draft, and what decides whether a deployment can transcribe?

## How it works

- [Dictation](../../CONTEXT.md) starts from the mic in the chat prompt toolbar: click to record, click again to stop; the transcript lands in the prompt draft at the caret, appended to existing text and never auto-sent, so several dictations can build one [Prompt](../../CONTEXT.md).
- Insertion goes through `document.execCommand('insertText')`, which fires a real input event so the embedded chat editor's store sees the text and native undo works.
- The browser posts the recording to the backend, the backend forwards it to Bifrost's transcription endpoint with the [Project](../../CONTEXT.md)'s chat virtual key, and the text comes back; the audio is never stored, logged or attached ([LLM Gateway](../gateways/llm-gateway.md)).
- The model is sent as `openai/gpt-4o-mini-transcribe`, which makes Bifrost dispatch to the real OpenAI provider and skip rotation ([ADR-0045](../adr/0045-transcription-is-pinned-to-the-real-openai-provider.md)).
- Spoken language is auto-detected; a dropdown on the mic pins a language per browser, and a badge shows when one is set, independent of the UI locale.
- Availability follows one fact, whether the real OpenAI provider holds a key: the backend asks Bifrost's admin API, caches the answer for a few minutes, and serves it with the model's supported languages so the dropdown and validation cannot drift.
- Three guardrails: recording auto-stops at five minutes, uploads over 10 MB are rejected before reaching the gateway, and the gateway call times out after about a minute.

## Edge cases

- When the capability is off, the mic renders disabled with a tooltip naming what would enable it; on the standalone subscription path that is the API-key option ([Codex Proxy](../gateways/codex-proxy.md)).
- Until the frontend has the availability answer, the mic stays disabled.
- When transcription fails, a toast names the reason (budget exhaustion as the Project's AI budget) and the browser keeps the recording in memory for one retry.
- When no speech is recognised, the prompt shows a "nothing recognized" hint.
- When the prompt editor cannot be found, the transcript is copied to the clipboard.

## Code

- `backend/src/transcription/` — the project-scoped endpoint, the pinned gateway call and the availability probe.
- `frontend/src/components/dictation-button.tsx` — recording, caret insertion and retry.
- `frontend/src/components/dictation-language.tsx` — the language override.

## Related

- [LLM Gateway](../gateways/llm-gateway.md) — the virtual key and budget Dictation rides on.
- [Codex Proxy](../gateways/codex-proxy.md) — the subscription upstream that cannot serve audio.
