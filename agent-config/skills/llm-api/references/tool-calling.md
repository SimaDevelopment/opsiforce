# Tool Calling

Source of truth for every parameter: OpenAI's [Function calling guide](https://developers.openai.com/api/docs/guides/function-calling).

Declare functions in `tools`; when the model wants one, `output` holds a `function_call` item. Run it, append the call and its result to `input`, and ask again:

```typescript
const tools: OpenAI.Responses.Tool[] = [
  {
    type: "function",
    name: "get_weather",
    description: "Current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    strict: true,
  },
]

const input: OpenAI.Responses.ResponseInput = [{ role: "user", content: question }]
const first = await ask({ model: "gpt-6.1-sol", input, tools, reasoning: { effort: "medium" }, max_output_tokens: 4000 })

for (const item of first.output) {
  if (item.type !== "function_call") continue
  const result = await getWeather(JSON.parse(item.arguments))
  input.push({ type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments })
  input.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) })
}

const { text } = await ask({ model: "gpt-6.1-sol", input, tools, reasoning: { effort: "medium" }, max_output_tokens: 4000 })
```

Append exactly these two items per call: the rest of `output` belongs to the provider that produced it, and the next turn may run elsewhere. An agent loops the same way until a reply holds no `function_call`. Function tools are the portable kind; the guide's hosted tools (web search, file search) run only on OpenAI's side.
