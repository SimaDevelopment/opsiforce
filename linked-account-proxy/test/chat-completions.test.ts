import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { event, respondWithEventStream, startLinkedAccountProxy } from './harness.ts';
import type { RunningProxy } from './harness.ts';

const USAGE = {
  input_tokens: 120,
  input_tokens_details: { cached_tokens: 100 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 12 },
  total_tokens: 150,
};

const CREATED = {
  type: 'response.created',
  response: { id: 'resp_1', created_at: 1_800_000_000, model: 'gpt-6.1-sol', status: 'in_progress' },
};

const TEXT_STREAM = [
  event(CREATED),
  event({ type: 'response.output_text.delta', delta: 'Hello' }),
  event({ type: 'response.output_text.delta', delta: ' there' }),
  event({ type: 'response.completed', response: { ...CREATED.response, status: 'completed', usage: USAGE } }),
];

const FUNCTION_CALL = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'get_weather',
  arguments: '{"city":"Paris"}',
};

const TOOL_CALL_STREAM = [
  event(CREATED),
  event({ type: 'response.output_item.added', output_index: 0, item: { ...FUNCTION_CALL, arguments: '' } }),
  event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' }),
  event({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"Paris"}' }),
  event({ type: 'response.output_item.done', output_index: 0, item: FUNCTION_CALL }),
  event({ type: 'response.completed', response: { ...CREATED.response, status: 'completed', usage: USAGE } }),
];

const QUESTION = [{ role: 'user', content: 'Weather in Paris?' }];

let proxy: RunningProxy;

const sendChat = (body: Record<string, unknown>) => proxy.postLikeBifrost('/v1/chat/completions', JSON.stringify(body));

beforeAll(async () => {
  proxy = await startLinkedAccountProxy({ maxBodyBytes: 64 * 1024 });
});

afterAll(async () => {
  await proxy.stop();
});

beforeEach(() => {
  proxy.upstream.requests.length = 0;
  proxy.upstream.respondWith(respondWithEventStream(TEXT_STREAM));
});

interface ChatChoice {
  message: { content: string | null; tool_calls?: unknown[] };
  finish_reason: string;
}

async function firstChoiceOf(res: Response): Promise<ChatChoice | undefined> {
  return ((await res.json()) as { choices: ChatChoice[] }).choices[0];
}

function chunksOf(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice(6))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as unknown);
}

describe('chat request conversion', () => {
  it('sends the conversation to ChatGPT as a streamed, unstored Responses request', async () => {
    await (
      await sendChat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'developer', content: [{ type: 'text', text: 'Answer in French.' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
            ],
          },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'look', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'a red square' },
          { role: 'system', content: 'Be brief.' },
        ],
        max_completion_tokens: 512,
        temperature: 0.2,
        reasoning_effort: 'high',
        prompt_cache_key: 'conversation-7',
        service_tier: 'priority',
      })
    ).text();

    expect(proxy.upstream.requests[0]?.headers['session-id']).toBe('conversation-7');
    expect(proxy.upstream.requests[0]?.body).toEqual({
      model: 'gpt-6.1-sol',
      instructions: 'You are terse.\n\nBe brief.',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'Answer in French.' }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is this?' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' },
          ],
        },
        { type: 'function_call', call_id: 'call_1', name: 'look', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a red square' },
      ],
      reasoning: { effort: 'high' },
      prompt_cache_key: 'conversation-7',
      service_tier: 'priority',
      store: false,
      stream: true,
    });
  });

  it('flattens function tools, keeps strict off unless asked, and maps tool choice and JSON schema output', async () => {
    await (
      await sendChat({
        model: 'gpt-6.1-sol',
        messages: QUESTION,
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: {} } },
          },
          {
            type: 'function',
            function: { name: 'strict_tool', parameters: { type: 'object', properties: {} }, strict: true },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'get_weather' } },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'weather', strict: true, schema: { type: 'object' } },
        },
      })
    ).text();

    const body = proxy.upstream.requests[0]?.body;
    expect(body?.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Weather',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
      { type: 'function', name: 'strict_tool', parameters: { type: 'object', properties: {} }, strict: true },
    ]);
    expect(body?.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
    expect(body?.text).toEqual({
      format: { type: 'json_schema', name: 'weather', strict: true, schema: { type: 'object' } },
    });
  });

  it('refuses what a single streamed response cannot carry, without calling ChatGPT', async () => {
    const severalChoices = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION, n: 2 });
    const audio = await sendChat({
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] }],
    });

    expect(severalChoices.status).toBe(400);
    expect(audio.status).toBe(400);
    expect(await audio.json()).toMatchObject({ error: { type: 'invalid_request_error' } });
    expect(proxy.upstream.requests).toHaveLength(0);
  });
});

describe('system messages', () => {
  const upstreamBody = () => proxy.upstream.requests[0]?.body;

  it('sends empty instructions when the conversation has no system message', async () => {
    await (await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION })).text();

    expect(upstreamBody()?.instructions).toBe('');
    expect(upstreamBody()?.input).toEqual(QUESTION);
  });

  it('moves a text-only system message into instructions without repeating it in the input', async () => {
    await (
      await sendChat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'Unique system prefix for token accounting.' },
          { role: 'user', content: 'hello' },
        ],
      })
    ).text();

    expect(upstreamBody()?.instructions).toBe('Unique system prefix for token accounting.');
    expect(upstreamBody()?.input).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('also keeps the system message in the input as a developer message in JSON mode, where ChatGPT looks for the word json', async () => {
    await (
      await sendChat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'Return JSON only.' },
          { role: 'user', content: 'symbol data' },
        ],
        response_format: { type: 'json_object' },
      })
    ).text();

    expect(upstreamBody()?.instructions).toBe('Return JSON only.');
    expect(upstreamBody()?.input).toEqual([
      { role: 'developer', content: 'Return JSON only.' },
      { role: 'user', content: 'symbol data' },
    ]);
    expect(upstreamBody()?.text).toEqual({ format: { type: 'json_object' } });
  });

  it('keeps a system message carrying an image in the input, with its text also in instructions', async () => {
    await (
      await sendChat({
        model: 'gpt-6.1-sol',
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: 'Inspect this reference image.' },
              { type: 'image_url', image_url: { url: 'https://example.com/reference.png' } },
            ],
          },
          { role: 'user', content: 'hello' },
        ],
      })
    ).text();

    expect(upstreamBody()?.instructions).toBe('Inspect this reference image.');
    expect(upstreamBody()?.input).toEqual([
      {
        role: 'developer',
        content: [
          { type: 'input_text', text: 'Inspect this reference image.' },
          { type: 'input_image', image_url: 'https://example.com/reference.png', detail: 'auto' },
        ],
      },
      { role: 'user', content: 'hello' },
    ]);
  });
});

describe('streamed chat completions', () => {
  it('turns text deltas into chat chunks, then a stop chunk, the usage chunk and [DONE]', async () => {
    const res = await sendChat({
      model: 'gpt-6.1-sol',
      messages: QUESTION,
      stream: true,
      stream_options: { include_usage: true },
    });
    const text = await res.text();

    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(chunksOf(text)).toEqual([
      {
        id: 'chatcmpl-resp_1',
        object: 'chat.completion.chunk',
        created: 1_800_000_000,
        model: 'gpt-6.1-sol',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-resp_1',
        object: 'chat.completion.chunk',
        created: 1_800_000_000,
        model: 'gpt-6.1-sol',
        choices: [{ index: 0, delta: { content: ' there' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-resp_1',
        object: 'chat.completion.chunk',
        created: 1_800_000_000,
        model: 'gpt-6.1-sol',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl-resp_1',
        object: 'chat.completion.chunk',
        created: 1_800_000_000,
        model: 'gpt-6.1-sol',
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 100 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    ]);
  });

  it('streams a function call as tool_call deltas and finishes with tool_calls', async () => {
    proxy.upstream.respondWith(respondWithEventStream(TOOL_CALL_STREAM));
    const chunks = chunksOf(await (await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION, stream: true })).text());

    expect(chunks.map((chunk) => (chunk as { choices: unknown[] }).choices[0])).toEqual([
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }],
        },
        finish_reason: null,
      },
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null },
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'tool_calls' },
    ]);
  });

  it('sends the whole arguments of a function call that arrives only when done', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        event(CREATED),
        event({ type: 'response.output_item.done', output_index: 0, item: FUNCTION_CALL }),
        event({ type: 'response.completed', response: { ...CREATED.response, status: 'completed' } }),
      ])
    );
    const choice = await firstChoiceOf(await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION }));

    expect(choice?.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
  });

  it('ends a stream that fails after output started with an error event and no [DONE]', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        event(CREATED),
        event({ type: 'response.output_text.delta', delta: 'Hel' }),
        event({ type: 'response.failed', response: { error: { message: 'Something broke', type: 'server_error' } } }),
      ])
    );
    const text = await (await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION, stream: true })).text();

    expect(text.includes('[DONE]')).toBe(false);
    expect(chunksOf(text).at(-1)).toEqual({ error: { message: 'Something broke', type: 'server_error' } });
  });
});

describe('buffered chat completions', () => {
  it('answers a caller that does not stream with one chat.completion carrying the usage', async () => {
    const res = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: 'chatcmpl-resp_1',
      object: 'chat.completion',
      created: 1_800_000_000,
      model: 'gpt-6.1-sol',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 100 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    });
  });

  it('answers a tool call with null content, the merged call and finish_reason tool_calls', async () => {
    proxy.upstream.respondWith(respondWithEventStream(TOOL_CALL_STREAM));
    const choice = await firstChoiceOf(await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION }));

    expect(choice).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('reports an output cut by the token limit as finish_reason length', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        event(CREATED),
        event({ type: 'response.output_text.delta', delta: 'Partial' }),
        event({
          type: 'response.incomplete',
          response: { ...CREATED.response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
        }),
      ])
    );
    const choice = await firstChoiceOf(await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION }));

    expect(choice?.finish_reason).toBe('length');
    expect(choice?.message.content).toBe('Partial');
  });
});

describe('a stream ChatGPT ends early', () => {
  const CUT_AFTER_DELTA = [event(CREATED), event({ type: 'response.output_text.delta', delta: 'Hel' })];

  it('ends a streaming caller with an error event and no [DONE] when the stream stops after a delta', async () => {
    proxy.upstream.respondWith(respondWithEventStream(CUT_AFTER_DELTA));
    const text = await (await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION, stream: true })).text();

    expect(text.includes('[DONE]')).toBe(false);
    expect(chunksOf(text).at(-1)).toMatchObject({ error: { code: 'stream_incomplete' } });
  });

  it('answers 502 to a buffered caller cut off after a delta, and to any caller of an empty or preamble-only stream', async () => {
    proxy.upstream.respondWith(respondWithEventStream(CUT_AFTER_DELTA));
    const afterDelta = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION });
    proxy.upstream.respondWith(respondWithEventStream([event(CREATED)]));
    const preambleOnly = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION, stream: true });
    proxy.upstream.respondWith(respondWithEventStream([]));
    const empty = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION });

    expect([afterDelta.status, preambleOnly.status, empty.status]).toEqual([502, 502, 502]);
    expect(await afterDelta.json()).toMatchObject({ error: { code: 'stream_incomplete' } });
  });
});

describe('failures before any output', () => {
  const RATE_LIMITED = [
    event(CREATED),
    event({
      type: 'response.failed',
      response: { error: { message: 'You have hit your usage limit.', code: 'usage_limit_reached' } },
    }),
  ];

  it('answers a usage limit with 429 for streaming and buffered callers alike, so the gateway can fail over', async () => {
    proxy.upstream.respondWith(respondWithEventStream(RATE_LIMITED));
    const streamed = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION, stream: true });
    const buffered = await sendChat({ model: 'gpt-6.1-sol', messages: QUESTION });

    expect(streamed.status).toBe(429);
    expect(buffered.status).toBe(429);
    expect(await buffered.json()).toMatchObject({
      error: { message: 'You have hit your usage limit.', code: 'usage_limit_reached' },
    });
  });
});
