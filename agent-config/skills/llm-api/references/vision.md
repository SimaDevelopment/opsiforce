# Vision (Image Analysis)

Source of truth for every parameter: OpenAI's [Images and vision guide](https://developers.openai.com/api/docs/guides/images-vision).

Pass `input_image` parts, with a public URL or a data URL; it works with GPT and Claude:

```typescript
const { text } = await ask({
  model: "gpt-6.1-sol",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What's in this image?" },
        { type: "input_image", image_url: "https://example.com/photo.jpg", detail: "auto" },
      ],
    },
  ],
  reasoning: { effort: "low" },
  max_output_tokens: 1500,
})
```

From an uploaded file buffer (e.g., via multer or formidable), pass a data URL instead:

```typescript
const dataUrl = `data:${mimetype};base64,${buffer.toString("base64")}`
// { type: "input_image", image_url: dataUrl, detail: "auto" }
```

`detail` trades tokens for precision: `"low"` (fast, fewer tokens), `"high"` (detailed analysis), `"auto"` (model decides). Several images are several `input_image` parts. For questions that need reasoning *about* the image (counting, diagnosis, judgement), raise `reasoning.effort` to `"medium"`/`"high"`.
