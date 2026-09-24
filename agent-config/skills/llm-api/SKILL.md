---
name: llm-api
description: Worked recipes for AI through the platform's LLM gateway — chat and text completions, structured output, streaming, vision, image generation and editing, text-to-speech, and audio/video transcription, across OpenAI (GPT) and Anthropic (Claude) models with reasoning-effort control. Use whenever a task needs AI, whether in an App feature or a one-off job done directly from the shell.
---

# AI API Integration

The gateway, its `APP_LLM_*` variables and the ban on local models are in the `platform` skill; this skill is the recipes. `APP_LLM_BASE_URL` already includes `/v1`.

The endpoint is a gateway that routes to both OpenAI and Anthropic. You select the provider with the `provider/model` prefix in the `model` field (e.g. `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-5`). One SDK, one key, both providers. **Always include the prefix** — a prefixed model routes deterministically to that provider, while an unprefixed name makes the gateway search its catalog across all configured providers and may resolve somewhere you didn't intend.

## Setup (OpenAI SDK)

The `openai` SDK is the right default — it talks to the gateway's OpenAI-compatible endpoint and reaches **both** GPT and Claude models. You do not need a separate Anthropic SDK.

Install:
```bash
yarn add openai
```

Initialize:
```typescript
import OpenAI from "openai"

const llm = new OpenAI({
  apiKey: process.env.APP_LLM_API_KEY,
  baseURL: process.env.APP_LLM_BASE_URL,
})
```

### Choosing a library

- **`openai` (default, recommended)** — covers everything these apps need against the gateway: chat completions, structured output (`response_format`), streaming, tool/function calling, reasoning effort, vision, and Whisper audio. One dependency, owned by the API vendor. Use it unless you have a specific reason not to.
- **Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`)** — only worth adding if you need provider-agnostic structured output (`generateObject`) or multi-step agent orchestration (`generateText` with `stopWhen`, the `Agent` abstraction). The gateway already unifies providers at the wire level, so the AI SDK's main selling point adds little here. Don't reach for it for ordinary completions/streaming.
- **`@anthropic-ai/sdk`, LangChain** — not needed. Claude is reachable through the `openai` SDK via the gateway; LangChain is overkill for app-level AI features.

## Picking a Model

Pick by **role**, not by memorized name — providers ship new versions constantly, and the role conventions below outlive any single release. Resolve the role to a current model id, then set [reasoning effort](#reasoning-effort-important) to match the task. Those two choices *together* decide quality — a capable model with no reasoning is just as weak as a cheap one. All chat models in both providers' current families are reasoning-capable and support vision.

> ⚠️ **The #1 cause of a weak "AI agent" is a cheap model running with no reasoning** — a cheap-role model at its default effort is fast and cheap and *consistently produces bad agents*. Anything that analyses, decides, or behaves agentically gets the **frontier role** (the default) with real reasoning effort. Save the cheap role for trivial, high-volume calls.

| Role | How to recognize the id | Snapshot (verified 2026-08) |
|------|-------------------------|------------------------------|
| **Frontier — the default** | Highest-versioned OpenAI flagship (`-sol` variant), or newest Claude Opus | `openai/gpt-5.6-sol` · `anthropic/claude-opus-5` |
| **Balanced** | `-terra` / `-mini` variant of the newest family, or newest Claude Sonnet | `openai/gpt-5.6-terra` · `anthropic/claude-sonnet-5` |
| **Cheap & fast** | `-luna` / `-nano` variant, or newest Claude Haiku | `openai/gpt-5.6-luna` · `anthropic/claude-haiku-4-5` |
| **Speech-to-text** | `whisper-*` | `openai/whisper-1` |
| **Text-to-speech** | `*-tts` | `openai/gpt-4o-mini-tts` |
| **Image generation** | `gpt-image-*` | `openai/gpt-image-2` |

Use the snapshot ids for day-to-day work. **Resolve fresh ids** when the gateway rejects a name, the user asks for the latest models, or the snapshot date looks stale:

```bash
curl -s "$APP_LLM_BASE_URL/models" -H "Authorization: Bearer $APP_LLM_API_KEY"
```

lists every model id the gateway currently routes; the official model pages — [OpenAI models](https://developers.openai.com/api/docs/models) and [Anthropic models](https://docs.claude.com/en/docs/about-claude/models/overview) — show what's newest per provider and which role it plays. Map the id to a role by the naming conventions above, then call the gateway with the exact id plus `provider/` prefix. One verified model name per call — never a retry ladder over guessed names.

### Choosing within a role

- **Default to the frontier role** for AI features and agents. **Step down to balanced** when volume, latency, or cost outweighs peak quality — balanced runs at roughly 40% of frontier price. **Cheap** is for genuinely simple, high-volume calls only, always with `"low"` effort, never none.
- **Structured output (JSON schema)** — prefer OpenAI models; `response_format: { type: "json_schema" }` is native to OpenAI and most reliable through the gateway.
- **Nuanced analysis / long-form writing** — Claude (Sonnet, or Opus for the hardest tasks).
- **Speech** — OpenAI only (Anthropic has no speech models): `openai/whisper-1` to transcribe, `openai/gpt-4o-mini-tts` to speak. **Vision** — any chat model; pick the role by how much the image task needs to *reason*, not just describe.

## Reasoning effort (IMPORTANT)

These are **reasoning models**. Left unconfigured they spend little or no effort "thinking" before answering — which produces shallow, low-quality results and is the most common cause of a disappointing AI feature. This bites hardest in **backend jobs and autonomous agents that run unattended**: no user is watching to catch a bad answer, so the model's first attempt has to be right. **Always set `reasoning_effort` explicitly, scaled to the task** — do not rely on the default.

```typescript
const response = await llm.chat.completions.create({
  model: "openai/gpt-5.6-sol",
  messages: [
    { role: "system", content: "You are a financial analyst." },
    { role: "user", content: prompt },
  ],
  reasoning_effort: "high",        // "low" | "medium" | "high" — newest OpenAI models also accept "xhigh" | "max"
  max_completion_tokens: 8000,
})
const text = response.choices[0].message.content
```

`reasoning_effort` works for GPT and for Claude **Haiku** through the gateway — for Haiku it is translated into an extended-thinking budget automatically, so you use the same field regardless of provider. **The exceptions are the current Claude Sonnet and Opus generations (Sonnet 5, Opus 5): omit `reasoning_effort` for them** — they reason adaptively on their own, and setting the field errors on the gateway (these models rejected the translated thinking budget).

### How much effort?

| Task | `reasoning_effort` | Why |
|------|-------------------|-----|
| Classification, tagging, extraction, formatting, simple lookups | `"low"` | Pattern work; reasoning adds latency and cost without improving the result |
| Summarization, rewriting, Q&A, most everyday generation | `"medium"` | Balanced default |
| Multi-step logic, data analysis, planning, drafting decisions, tool-using agents, anything a backend job decides or acts on unattended | `"high"` | Quality scales with reasoning — this is what separates a useful agent from one that's confidently wrong |

When in doubt, **start at `"medium"` and raise to `"high"`** if the output is shallow or makes mistakes. The newest OpenAI models accept `"xhigh"` and `"max"` above `"high"` — reserve those for the very hardest unattended jobs. Higher effort = better quality but more latency (the model thinks before the first token appears) and more cost (reasoning tokens are billed).

### Token limit — use `max_completion_tokens`

Cap output with **`max_completion_tokens`**, never `max_tokens` — the gateway silently ignores `max_tokens`, so that limit does nothing. This matters specifically because reasoning depends on it: reasoning tokens come out of this same budget, so size it generously (`8000`+ at `"high"` effort) or the visible answer gets truncated. For Claude the budget **must be > 1024** or the reasoning call fails outright; `4000`–`8000` is safe.

Pass `reasoning_effort` on its own — don't also send a manual `reasoning: {...}` object (sending both is an error).

## Common Patterns

### Text Generation

```typescript
const response = await llm.chat.completions.create({
  model: "openai/gpt-5.6-sol",
  messages: [{ role: "user", content: prompt }],
  reasoning_effort: "medium",
  max_completion_tokens: 2000,
})
const text = response.choices[0].message.content
```

### Structured Output (JSON)

Prefer an OpenAI model for structured output. For pure extraction, `"low"` effort is usually enough; raise it only if deciding the field values needs real reasoning.

Return typed JSON using `response_format`:

```typescript
const response = await llm.chat.completions.create({
  model: "openai/gpt-5.6-luna",
  messages: [
    {
      role: "system",
      content: "Extract entities as JSON: { \"names\": string[], \"locations\": string[], \"dates\": string[] }",
    },
    { role: "user", content: text },
  ],
  response_format: { type: "json_object" },
  reasoning_effort: "low",
  max_completion_tokens: 1500,
})

const data = JSON.parse(response.choices[0].message.content!)
// data.names, data.locations, data.dates
```

For stricter control, use a JSON schema:

```typescript
const response = await llm.chat.completions.create({
  model: "openai/gpt-5.6-sol",
  messages: [{ role: "user", content: "Analyze this product review: ..." }],
  reasoning_effort: "medium",
  max_completion_tokens: 2000,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "review_analysis",
      strict: true,
      schema: {
        type: "object",
        properties: {
          sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
          confidence: { type: "number" },
          topics: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
        required: ["sentiment", "confidence", "topics", "summary"],
        additionalProperties: false,
      },
    },
  },
})

const analysis = JSON.parse(response.choices[0].message.content!)
```

### Streaming

Stream responses to the frontend using Server-Sent Events:

```typescript
// API route handler
const stream = await llm.chat.completions.create({
  model: "openai/gpt-5.6-sol",
  messages: [{ role: "user", content: prompt }],
  reasoning_effort: "medium",
  max_completion_tokens: 2000,
  stream: true,
})

// Write SSE events
res.setHeader("Content-Type", "text/event-stream")
res.setHeader("Cache-Control", "no-cache")

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content
  if (content) {
    res.write(`data: ${JSON.stringify({ content })}\n\n`)
  }
}
res.write("data: [DONE]\n\n")
res.end()
```

With higher `reasoning_effort` the model thinks before the first content token, so there is a pause before streaming begins. Show a "thinking…" indicator on the frontend so the wait reads as intentional.

### Multi-turn Conversation

```typescript
const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "system", content: "You are a helpful assistant." },
]

async function chat(userMessage: string): Promise<string> {
  messages.push({ role: "user", content: userMessage })

  const response = await llm.chat.completions.create({
    model: "openai/gpt-5.6-sol",
    messages,
    reasoning_effort: "medium",
    max_completion_tokens: 2000,
  })

  const reply = response.choices[0].message.content!
  messages.push({ role: "assistant", content: reply })
  return reply
}
```

### Vision (Image Analysis)

Analyze images by passing `image_url` content parts:

```typescript
const response = await llm.chat.completions.create({
  model: "openai/gpt-5.6-sol",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this image?" },
        {
          type: "image_url",
          image_url: { url: "https://example.com/photo.jpg" },
        },
      ],
    },
  ],
  reasoning_effort: "low",
  max_completion_tokens: 1500,
})
const description = response.choices[0].message.content
```

From an uploaded file buffer (e.g., via multer or formidable):

```typescript
const base64 = buffer.toString("base64")
const dataUrl = `data:${mimetype};base64,${base64}`

const response = await llm.chat.completions.create({
  model: "openai/gpt-5.6-sol",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: { url: dataUrl, detail: "auto" },
        },
      ],
    },
  ],
  reasoning_effort: "low",
  max_completion_tokens: 1500,
})
```

The `detail` parameter controls token usage: `"low"` (fixed 85 tokens, fast), `"high"` (detailed analysis, more tokens), `"auto"` (model decides). Multiple images can be sent as additional `image_url` entries in the content array. For questions that require reasoning *about* the image (counting, diagnosis, judgement), raise `reasoning_effort` to `"medium"`/`"high"`.

### Audio Transcription

Convert audio to text using the Whisper API (no reasoning settings apply):

```typescript
import { createReadStream } from "fs"

const transcription = await llm.audio.transcriptions.create({
  file: createReadStream("audio.mp3"),
  model: "openai/whisper-1",
})
const text = transcription.text
```

From an uploaded file buffer, with the optional tuning parameters:

```typescript
import { toFile } from "openai"

const transcription = await llm.audio.transcriptions.create({
  file: await toFile(buffer, "audio.webm"),
  model: "openai/whisper-1",
  language: "en",
  response_format: "verbose_json",
  prompt: "Technical meeting about Kubernetes deployments",
})
```

Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm (max 25 MB). Use `response_format` for different outputs: `"text"` (plain string), `"json"` (with text field), `"verbose_json"` (with word-level timestamps), `"srt"` or `"vtt"` (subtitle formats).

#### Direct task — transcribe a file yourself, no app

When asked to transcribe a video/podcast/audio (not build an app), skip app code — fetch the media and post it to the gateway from the shell:

```bash
yt-dlp -x --audio-format mp3 -o audio.mp3 "<url>"   # or, for a local file: ffmpeg -i input.mp4 -vn audio.mp3
curl -s "$APP_LLM_BASE_URL/audio/transcriptions" \
  -H "Authorization: Bearer $APP_LLM_API_KEY" \
  -F model=openai/whisper-1 -F response_format=text -F file=@audio.mp3
```

Whisper accepts up to 25 MB per request — split longer media with `ffmpeg` (`-f segment -segment_time 900`) and join the text.

### Text to Speech

Generate spoken audio from text with `openai/gpt-4o-mini-tts` via `audio.speech.create`. It is the only TTS model to use — `tts-1`/`tts-1-hd` are legacy models that ignore `instructions`.

```typescript
const response = await llm.audio.speech.create({
  model: "openai/gpt-4o-mini-tts",
  voice: "marin",
  input: text,
  instructions: "Speak warmly and clearly, with natural pacing and gentle pauses at punctuation.",
  response_format: "mp3",
})
const audio = Buffer.from(await response.arrayBuffer())
```

- **Voices**: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `marin`, `cedar`, `nova`, `onyx`, `sage`, `shimmer`, `verse`. `marin` and `cedar` give the best quality — default to one of them unless the user picks a voice.
- **`instructions`** steers *how* the text is spoken — accent, emotion, pacing, tone, whispering. For non-English text, name the language and ask for native pronunciation (e.g. "Read this Ukrainian text with accurate Ukrainian pronunciation"). It cannot change *what* is spoken; the model reads `input` verbatim.
- **`response_format`**: `"mp3"` (default) for stored/downloaded audio; `"wav"` or `"pcm"` when streaming playback needs the lowest latency.
- Reasoning settings (`reasoning_effort`, `max_completion_tokens`) do not apply.
- Keep TTS calls server-side and return the audio (or a URL to it) to the client.

#### Direct task — speak a text yourself, no app

```bash
curl -s "$APP_LLM_BASE_URL/audio/speech" \
  -H "Authorization: Bearer $APP_LLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-4o-mini-tts","voice":"marin","input":"Hello there","instructions":"Speak warmly."}' \
  -o speech.mp3
```

### Image Generation

Generate an image from a text prompt with `gpt-image-2` (the current OpenAI image model) via `images.generate`. Image models **always return base64** (`b64_json`) — there is no URL to fetch.

```typescript
const result = await llm.images.generate({
  model: "openai/gpt-image-2",
  prompt: "A watercolor illustration of a fox in a forest, soft morning light",
  size: "1024x1024",   // "1024x1024" | "1536x1024" (landscape) | "1024x1536" (portrait) | "auto"
  quality: "medium",   // "low" | "medium" | "high" | "auto"
})

const b64 = result.data[0].b64_json!
const buffer = Buffer.from(b64, "base64") // save to disk, store, or return to the client
```

Return it to the frontend as a data URL, or persist the buffer and serve it from your own endpoint:

```typescript
const dataUrl = `data:image/png;base64,${result.data[0].b64_json}`
```

**Edit an existing image** (inpainting / variations) with `images.edit` — pass the source image and an optional mask:

```typescript
import { toFile } from "openai"

const edited = await llm.images.edit({
  model: "openai/gpt-image-2",
  image: await toFile(buffer, "input.png", { type: "image/png" }),
  prompt: "Add a red scarf around the fox's neck",
})
const out = edited.data[0].b64_json!
```

- `n` (1–10) returns multiple images; `background: "transparent"` requires `output_format: "png"` or `"webp"`.
- Cost scales with `size` × `quality` — default to `"medium"`, use `"high"` only when detail matters. Image calls draw on the same project budget as chat.
- Reasoning settings (`reasoning_effort`, `max_completion_tokens`) do not apply to image generation.

## Guidelines

- **Always set `reasoning_effort`**, scaled to the task (omit it for Claude Sonnet / Opus) — see [Reasoning effort](#reasoning-effort-important).
- **Use `max_completion_tokens`, never `max_tokens`** — see [Token limit](#token-limit--use-max_completion_tokens).
- **Speech in an app** — record with `MediaRecorder` and process it server-side; as a direct task, use the shell recipes above.
- **Verify unknown model names** — see [Picking a Model](#picking-a-model).
- **Backend only** — never expose `APP_LLM_API_KEY` to the frontend or client-side code.
- **For streaming responses to the frontend, use Server-Sent Events (SSE).**
