# Text-to-Speech

Source of truth for every parameter: OpenAI's [Text to speech guide](https://developers.openai.com/api/docs/guides/text-to-speech).

Speak text with `gpt-4o-mini-tts` via `audio.speech.create`; `tts-1` / `tts-1-hd` are legacy models that ignore `instructions`. Reasoning settings don't apply. Keep the call server-side and return the audio (or a URL to it) to the client.

```typescript
const response = await llm.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: "marin",
  input: text,
  instructions: "Speak warmly and clearly, with natural pacing and gentle pauses at punctuation.",
  response_format: "mp3",
})
const audio = Buffer.from(await response.arrayBuffer())
```

- **Voices**: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `marin`, `cedar`, `nova`, `onyx`, `sage`, `shimmer`, `verse`. `marin` and `cedar` give the best quality; default to one of them unless the user picks a voice.
- **`instructions`** steers *how* the text is spoken: accent, emotion, pacing, tone, whispering. For non-English text, name the language and ask for native pronunciation (e.g. "Read this Ukrainian text with accurate Ukrainian pronunciation"). The model reads `input` verbatim.
- **`response_format`**: `"mp3"` for stored or downloaded audio; `"wav"` or `"pcm"` when streaming playback needs the lowest latency.

## Direct task: speak a text yourself, no app

```bash
curl -s "$APP_LLM_BASE_URL/audio/speech" \
  -H "Authorization: Bearer $APP_LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini-tts","voice":"marin","input":"Hello there","instructions":"Speak warmly."}' \
  -o speech.mp3
```
