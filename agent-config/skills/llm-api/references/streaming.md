# Streaming to the Browser

Source of truth for every event type: OpenAI's [Streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses).

Forward the text deltas to the frontend with Server-Sent Events, and skip every event type you don't use: the gateway adds events of its own.

```typescript
// API route handler
const stream = await llm.responses.create({
  model: "gpt-6.1-sol",
  input: prompt,
  reasoning: { effort: "medium" },
  max_output_tokens: 2000,
  store: false,
  stream: true,
})

res.setHeader("Content-Type", "text/event-stream")
res.setHeader("Cache-Control", "no-cache")

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    res.write(`data: ${JSON.stringify({ content: event.delta })}\n\n`)
  } else if (event.type === "response.incomplete") {
    res.write(`data: ${JSON.stringify({ error: "The answer was cut off" })}\n\n`)
    break
  } else if (event.type === "response.failed" || event.type === "error") {
    res.write(`data: ${JSON.stringify({ error: "The AI call failed" })}\n\n`)
    break
  }
}
res.write("data: [DONE]\n\n")
res.end()
```

With higher reasoning effort the model thinks before the first text arrives, so there is a pause before streaming begins. Show a "thinking…" indicator on the frontend so the wait reads as intentional.
