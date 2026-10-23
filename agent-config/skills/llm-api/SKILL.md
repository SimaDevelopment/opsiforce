---
name: llm-api
description: Worked recipes for AI through the platform's LLM gateway, for GPT and Claude models — text generation, structured output, streaming, multi-turn conversations, tool calling, vision, image generation and editing, text-to-speech, and audio/video transcription. Use whenever a task needs AI, whether in an App feature or a one-off job done directly from the shell.
---

# AI API Integration

The gateway, its `APP_LLM_*` variables and the ban on local models are in the `platform` skill; this skill is the recipes. `APP_LLM_BASE_URL` already includes `/v1`.

The gateway serves GPT and Claude models through one SDK and one key, and the Organization chooses which providers serve each model family. Two rules keep every call on the Organization's choice:

- **Bare model ids** — `gpt-6.1-sol`, `claude-sonnet-5-5`, `whisper-1`. The gateway knows each model's family and routes it to that family's providers; a `provider/` prefix would pin a single provider instead. When the gateway answers that it could not resolve a provider for a model, the model isn't available here: pick another id from the [model list](#picking-a-model) rather than adding the prefix its message suggests.
- **Streamed Responses calls** — every text call is `llm.responses.create({ ..., stream: true })`, for GPT and Claude alike, read through `ask()` below or event by event. It is OpenAI's recommended API, and every provider the Organization can choose serves it, most of them natively.

The recipes show shapes known to work through this gateway. The official guides are the source of truth for every parameter a recipe doesn't show: each reference below links its guide, and OpenAI's [migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) maps Chat Completions code onto Responses.

## Setup (OpenAI SDK)

The `openai` SDK reaches GPT and Claude alike through the gateway; it is the only AI library an App needs. Keep every call on the backend: `APP_LLM_API_KEY` never reaches the frontend.

```bash
yarn add openai
```

```typescript
import OpenAI from "openai"

const llm = new OpenAI({
  apiKey: process.env.APP_LLM_API_KEY,
  baseURL: process.env.APP_LLM_BASE_URL,
})

// One complete answer from a streamed call: the text, plus the output items (tool calls) when you need them.
async function ask(params: Omit<OpenAI.Responses.ResponseCreateParamsStreaming, "stream" | "store">) {
  const stream = await llm.responses.create({ ...params, store: false, stream: true })
  let text = ""
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") text += event.delta
    else if (event.type === "response.completed") return { text, output: event.response.output }
    else if (event.type === "response.incomplete") throw new Error(`AI answer cut off: ${event.response.incomplete_details?.reason}`)
    else if (event.type === "response.failed" || event.type === "error") throw new Error(`AI call failed: ${JSON.stringify(event)}`)
  }
  throw new Error("AI call ended before its answer completed")
}
```

`ask()` reads the events itself and skips the types it doesn't use: the gateway adds events of its own, which the SDK's `llm.responses.stream()` helper rejects. It returns only a completed answer and throws on anything else, so a cut-off or failed call never passes for a full one. `store: false` keeps nothing on the provider's side; the conversation lives in your code.

## Picking a Model

Pick by **role**, not by memorized name — providers ship new versions constantly, and the role conventions below outlive any single release. Resolve the role to a current model id, then set [reasoning effort](#reasoning-effort-important) to match the task. Those two choices *together* decide quality — a capable model with no reasoning is just as weak as a cheap one. All chat models in both providers' current families are reasoning-capable and support vision.

> ⚠️ **The #1 cause of a weak "AI agent" is a cheap model running with no reasoning** — a cheap-role model at its default effort is fast and cheap and *consistently produces bad agents*. Anything that analyses, decides, or behaves agentically gets the **frontier role** (the default) with real reasoning effort. Save the cheap role for trivial, high-volume calls.

| Role | How to recognize the id | Snapshot (verified 2026-10) |
|------|-------------------------|------------------------------|
| **Frontier — the default** | Highest-versioned OpenAI flagship (`-sol` variant), or newest Claude Opus | `gpt-6.1-sol` · `claude-opus-5-5` |
| **Balanced** | `-terra` / `-mini` variant of the newest family, or newest Claude Sonnet | `gpt-5.6-terra` · `claude-sonnet-5-5` |
| **Cheap & fast** | `-luna` / `-nano` variant, or newest Claude Haiku | `gpt-6-luna` · `claude-haiku-5-5` |
| **Speech-to-text** | `whisper-*` | `whisper-1` |
| **Text-to-speech** | `*-tts` | `gpt-4o-mini-tts` |
| **Image generation** | `gpt-image-*` | `gpt-image-2` |

Use the snapshot ids for day-to-day work. **Resolve fresh ids** when the gateway rejects a name, the user asks for the latest models, or the snapshot date looks stale:

```bash
curl -s "$APP_LLM_BASE_URL/models" -H "Authorization: Bearer $APP_LLM_API_KEY"
```

lists every model the gateway currently routes, each as `<provider>/<model>`; send only the part after the first `/`. The official model pages — [OpenAI models](https://developers.openai.com/api/docs/models) and [Anthropic models](https://platform.claude.com/docs/en/models/overview) — show what's newest per family and which role it plays. Map the id to a role by the naming conventions above, then call the gateway with that bare id. One verified model name per call — never a retry ladder over guessed names.

### Choosing within a role

- **Default to the frontier role** for AI features and agents. **Step down to balanced** when volume, latency, or cost outweighs peak quality — balanced runs at roughly 40% of frontier price. **Cheap** is for genuinely simple, high-volume calls only, always with `"low"` effort, never none.
- **Nuanced analysis / long-form writing** — Claude (Sonnet, or Opus for the hardest tasks).
- **Speech** — OpenAI only (Anthropic has no speech models). **Vision** — any chat model; pick the role by how much the image task needs to *reason*, not just describe.

## Reasoning effort (IMPORTANT)

These are **reasoning models**. Left unconfigured they spend little or no effort "thinking" before answering — which produces shallow, low-quality results and is the most common cause of a disappointing AI feature. This bites hardest in **backend jobs and autonomous agents that run unattended**: no user is watching to catch a bad answer, so the model's first attempt has to be right. **Always set `reasoning.effort` explicitly, scaled to the task** — do not rely on the default. The official [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) has the details.

```typescript
const { text } = await ask({
  model: "gpt-6.1-sol",
  instructions: "You are a financial analyst.",
  input: prompt,
  reasoning: { effort: "high" },   // "low" | "medium" | "high" — newest OpenAI models also accept "xhigh" | "max"
  max_output_tokens: 8000,
})
```

`reasoning.effort` works the same for GPT and Claude; the gateway turns it into Claude's thinking budget.

### How much effort?

| Task | `reasoning.effort` | Why |
|------|-------------------|-----|
| Classification, tagging, extraction, formatting, simple lookups | `"low"` | Pattern work; reasoning adds latency and cost without improving the result |
| Summarization, rewriting, Q&A, most everyday generation | `"medium"` | Balanced default |
| Multi-step logic, data analysis, planning, drafting decisions, tool-using agents, anything a backend job decides or acts on unattended | `"high"` | Quality scales with reasoning — this is what separates a useful agent from one that's confidently wrong |

When in doubt, **start at `"medium"` and raise to `"high"`** if the output is shallow or makes mistakes. The newest OpenAI models accept `"xhigh"` and `"max"` above `"high"` — reserve those for the very hardest unattended jobs. Higher effort = better quality but more latency (the model thinks before the first token appears) and more cost (reasoning tokens are billed).

### Token limit — `max_output_tokens`

Cap output with **`max_output_tokens`**. Reasoning tokens come out of this same budget, so size it generously (`8000`+ at `"high"` effort): a call that runs out ends with `response.incomplete` (reason `max_output_tokens`), which `ask()` throws as a cut-off answer. With reasoning on, Claude needs **more than 1024**, or the call fails; `4000`–`8000` is safe.

## Text Generation

Source of truth for every parameter: OpenAI's [Text generation guide](https://developers.openai.com/api/docs/guides/text).

```typescript
const { text } = await ask({
  model: "gpt-6.1-sol",
  input: prompt,
  reasoning: { effort: "medium" },
  max_output_tokens: 2000,
})
```

`instructions` carries the system prompt; `input` takes a string or a list of `{ role, content }` messages.

## Recipes by Task

Read the reference a task needs before writing its call; each one has a worked example, what differs on this gateway, and its official guide.

- **When a call must return JSON your code parses, Read references/structured-output.md.**
- **When an answer streams into the UI as it is generated, Read references/streaming.md.**
- **When a feature keeps a back-and-forth with the user, Read references/conversations.md.**
- **When the model calls your functions or acts as an agent, Read references/tool-calling.md.**
- **When the model reads an image, Read references/vision.md.**
- **When a task creates or edits an image, Read references/image-generation.md.**
- **When a task speaks text aloud, Read references/text-to-speech.md.**
- **When a task turns audio or video into text, Read references/transcription.md.**
