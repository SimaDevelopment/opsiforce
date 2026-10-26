# Structured Output (JSON)

Source of truth for every parameter: OpenAI's [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

Give a JSON schema in `text.format`; it works with GPT and Claude. `strict: true` needs every property listed in `required` and `additionalProperties: false`. For pure extraction, `"low"` effort is usually enough; raise it only if deciding the field values needs real reasoning.

```typescript
const { text } = await ask({
  model: "gpt-6.1-sol",
  input: `Analyze this product review: ${review}`,
  reasoning: { effort: "low" },
  max_output_tokens: 2000,
  text: {
    format: {
      type: "json_schema",
      name: "review_analysis",
      strict: true,
      schema: {
        type: "object",
        properties: {
          sentiment: { type: "string", enum: ["positive", "negative", "mixed"] },
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

const analysis = JSON.parse(text)
```

Every structured call carries a schema: schema-less JSON mode (`type: "json_object"`) gets JSON wrapped in a Markdown code fence from Claude, which `JSON.parse` rejects.
