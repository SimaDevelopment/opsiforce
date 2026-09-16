# Transcription is pinned to the real OpenAI provider

Dictation rides the Project's chat virtual key so it shares the Project's LLM budget, but that key's normal routing goes to OpenAI-compatible custom providers whose Bifrost config forbids transcription and whose upstreams expose no audio endpoint. Weighted rotation would therefore send audio to a provider that cannot take it and fail invisibly, so the backend sends the model as `openai/gpt-4o-mini-transcribe`, where the `openai/` prefix makes Bifrost dispatch directly to the real OpenAI provider and skip rotation. Whether a deployment can transcribe follows from one fact, whether that provider holds a key, which the backend probes through Bifrost's admin API rather than through a hand-maintained flag.

## Considered options

- **`whisper-1`.** Rejected: worse word error rate at twice the price; its subtitle formats and word timestamps are irrelevant to dictation.
- **A separate transcription credential.** Rejected: a second budget surface for one feature.

## Consequences

- If Bifrost ever changes its provider-prefix semantics every dictation fails with gateway errors while chat keeps working; the fix is that one model string.
- On the standalone subscription path the real provider has no key, so the mic is disabled with a tooltip rather than failing on use.
