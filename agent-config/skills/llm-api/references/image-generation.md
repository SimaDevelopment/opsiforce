# Image Generation and Editing

Source of truth for every parameter: OpenAI's [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation).

Generate with `gpt-image-2` via `images.generate`. Image models **always return base64** (`b64_json`); there is no URL to fetch. Reasoning settings don't apply.

```typescript
const result = await llm.images.generate({
  model: "gpt-image-2",
  prompt: "A watercolor illustration of a fox in a forest, soft morning light",
  size: "1024x1024",   // "1024x1024" | "1536x1024" (landscape) | "1024x1536" (portrait) | "auto"
  quality: "medium",   // "low" | "medium" | "high" | "auto"
})

const buffer = Buffer.from(result.data[0].b64_json!, "base64") // save, store, or return to the client
```

Return it to the frontend as a data URL, or persist the buffer and serve it from your own endpoint:

```typescript
const dataUrl = `data:image/png;base64,${result.data[0].b64_json}`
```

**Edit an existing image** (inpainting, variations) with `images.edit`: pass the source image and an optional mask.

```typescript
import { toFile } from "openai"

const edited = await llm.images.edit({
  model: "gpt-image-2",
  image: await toFile(buffer, "input.png", { type: "image/png" }),
  prompt: "Add a red scarf around the fox's neck",
})
const out = edited.data[0].b64_json!
```

- `n` (1–10) returns several images; `background: "transparent"` requires `output_format: "png"` or `"webp"`.
- Cost scales with `size` × `quality`: default to `"medium"`, use `"high"` only when detail matters. Image calls draw on the same project budget as chat.
- Generation takes several seconds; show progress in the UI.
