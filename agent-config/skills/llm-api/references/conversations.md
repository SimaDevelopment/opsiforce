# Conversations

Source of truth for every parameter: OpenAI's [Conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state).

Keep the conversation in your own code and send all of it on every turn. Consecutive turns may be served by different providers, so none of them holds the history: the guide's `previous_response_id` and stored conversations have nothing to point at here, and `ask()` sends `store: false`.

```typescript
const history: { role: "user" | "assistant"; content: string }[] = []

async function chat(userMessage: string): Promise<string> {
  history.push({ role: "user", content: userMessage })

  const { text } = await ask({
    model: "gpt-6.1-sol",
    instructions: "You are a helpful assistant.",
    input: history,
    reasoning: { effort: "medium" },
    max_output_tokens: 2000,
  })

  history.push({ role: "assistant", content: text })
  return text
}
```

Persist `history` per conversation (for example in the App's database) when it must outlive the process.
