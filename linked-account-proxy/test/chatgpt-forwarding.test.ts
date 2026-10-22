import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { BIFROST_AUTHORIZATION, LINKED_ACCOUNT, respondWithEventStream, startLinkedAccountProxy } from './harness.ts';
import type { RunningProxy } from './harness.ts';

const COMPLETED_RESPONSE = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello there' }] }],
};

const CHATGPT_STREAM = [
  { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hello there' } },
  { event: 'response.completed', data: { type: 'response.completed', response: COMPLETED_RESPONSE } },
];

const USER_TURN = [{ role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] }];

const MAX_BODY_BYTES = 64 * 1024;

let proxy: RunningProxy;

beforeAll(async () => {
  proxy = await startLinkedAccountProxy({ maxBodyBytes: MAX_BODY_BYTES });
});

afterAll(async () => {
  await proxy.stop();
});

beforeEach(() => {
  proxy.upstream.requests.length = 0;
  proxy.upstream.respondWith(respondWithEventStream(CHATGPT_STREAM));
});

describe('body rewrite', () => {
  it('defaults instructions to an empty string, turns storage off, forces streaming and drops what ChatGPT refuses', async () => {
    const res = await proxy.sendLikeBifrost({
      model: 'gpt-5.6-sol',
      input: USER_TURN,
      max_output_tokens: 512,
      temperature: 0.2,
      top_p: 0.9,
      user: 'app-user-7',
      metadata: { feature: 'review' },
      safety_identifier: 'app-user-7',
      truncation: 'auto',
    });
    await res.text();

    expect(proxy.upstream.requests).toHaveLength(1);
    expect(proxy.upstream.requests[0]?.body).toEqual({
      model: 'gpt-5.6-sol',
      input: USER_TURN,
      instructions: '',
      store: false,
      stream: true,
      prompt_cache_key: expect.stringMatching(/^lap-[0-9a-f]{32}$/),
    });
  });

  it("keeps the caller's own instructions and store setting", async () => {
    const res = await proxy.sendLikeBifrost({
      model: 'gpt-5.6-sol',
      input: USER_TURN,
      instructions: 'You are terse.',
      store: true,
      stream: false,
    });
    await res.text();

    expect(proxy.upstream.requests[0]?.body).toMatchObject({
      instructions: 'You are terse.',
      store: true,
      stream: true,
    });
  });

  it('rejects a previous_response_id without calling ChatGPT', async () => {
    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, previous_response_id: 'resp_0' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: 'unsupported_replay_state' } });
    expect(proxy.upstream.requests).toHaveLength(0);
  });

  it('rejects an item_reference in the input without calling ChatGPT', async () => {
    const res = await proxy.sendLikeBifrost({
      model: 'gpt-5.6-sol',
      input: [...USER_TURN, { type: 'item_reference', id: 'msg_0' }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { type: 'unsupported_replay_state' } });
    expect(proxy.upstream.requests).toHaveLength(0);
  });
});

describe('upstream headers', () => {
  it("sends the linked account's token and account id as the Codex CLI, never the caller's key", async () => {
    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });
    await res.text();

    const headers = proxy.upstream.requests[0]?.headers;
    expect(headers?.authorization).toBe(`Bearer ${LINKED_ACCOUNT.accessToken}`);
    expect(headers?.authorization).not.toBe(BIFROST_AUTHORIZATION);
    expect(headers?.['chatgpt-account-id']).toBe(LINKED_ACCOUNT.accountId);
    expect(headers?.originator).toBe('codex_cli_rs');
  });

  it('sends the prompt cache key as the session-id ChatGPT routes its cache by', async () => {
    const res = await proxy.sendLikeBifrost({
      model: 'gpt-6.1-sol',
      input: USER_TURN,
      prompt_cache_key: 'ses_eb77bb310ffeMdyelnVWjuZJZ8',
    });
    await res.text();

    const request = proxy.upstream.requests[0];
    expect(request?.headers['session-id']).toBe('ses_eb77bb310ffeMdyelnVWjuZJZ8');
    expect(request?.body.prompt_cache_key).toBe('ses_eb77bb310ffeMdyelnVWjuZJZ8');
  });

  it('derives a cache key from how the conversation starts when the caller gives none, so its later turns share it', async () => {
    const reply = { role: 'assistant', content: 'Hello!' };
    const nextTurn = { role: 'user', content: [{ type: 'input_text', text: 'And again' }] };
    const otherConversation = [{ role: 'user', content: [{ type: 'input_text', text: 'Something else' }] }];
    for (const input of [USER_TURN, [...USER_TURN, reply, nextTurn], otherConversation]) {
      await (await proxy.sendLikeBifrost({ model: 'gpt-6.1-sol', input, prompt_cache_key: '' })).text();
    }

    const [first, later, other] = proxy.upstream.requests.map(
      (upstreamRequest) => upstreamRequest.headers['session-id']
    );
    expect(first).toMatch(/^lap-[0-9a-f]{32}$/);
    expect(later).toBe(first);
    expect(other).not.toBe(first);
    expect(proxy.upstream.requests[0]?.body.prompt_cache_key).toBe(first);
  });
});

describe('responses', () => {
  it('passes the event stream through unchanged to a streaming caller', async () => {
    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await res.text()).toBe(
      CHATGPT_STREAM.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    );
  });

  it('answers a stream that fails before any output with an HTTP error the gateway can act on', async () => {
    const refusal = {
      type: 'invalid_request_error',
      code: 'invalid_encrypted_content',
      message: 'The encrypted content for item rs_1 could not be verified.',
    };
    proxy.upstream.respondWith(
      respondWithEventStream([
        ...CHATGPT_STREAM.slice(0, 1),
        { event: 'error', data: { type: 'error', error: refusal } },
      ])
    );

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: refusal });
  });

  it('looks past keepalive comments and id/retry blocks for an early failure', async () => {
    const refusal = { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'Not verified.' };
    proxy.upstream.respondWith((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      res.write('retry: 1000\n\n');
      res.write('id: 1\n\n');
      res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: refusal })}\n\n`);
    });

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: refusal });
  });

  it('passes keepalive comments through unchanged once output starts', async () => {
    const delta = { type: 'response.output_text.delta', delta: 'Hi' };
    const body = `: ping\n\nevent: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\n`;
    proxy.upstream.respondWith((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(body);
    });

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it('answers a response.failed rate limit before any output with 429', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: { id: 'resp_1', status: 'failed', error: { code: 'rate_limit_exceeded', message: 'Slow down.' } },
          },
        },
      ])
    );

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: { type: 'upstream_error', code: 'rate_limit_exceeded', message: 'Slow down.' },
    });
  });

  it('answers a rate limit with 429 to a caller that does not stream too', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: { id: 'resp_1', status: 'failed', error: { code: 'usage_limit_reached', message: 'Limit hit.' } },
          },
        },
      ])
    );

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });

    expect(res.status).toBe(429);
  });

  it('answers a server failure before any output with 502', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([{ event: 'error', data: { type: 'error', code: 'server_error', message: 'Try again.' } }])
    );

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(502);
  });

  it('answers overload signals before any output with 502, whether coded or only worded, so the gateway fails over', async () => {
    const overloads = [
      { type: 'error', code: 'server_is_overloaded', message: 'Our servers are currently overloaded.' },
      { type: 'error', code: 'slow_down', message: 'Slow down.' },
      { type: 'error', message: 'The selected model is at capacity. Please try a different model.' },
      { type: 'error', message: 'An error occurred while processing your request. Please try again.' },
    ];
    const statuses: number[] = [];
    for (const overload of overloads) {
      proxy.upstream.respondWith(respondWithEventStream([{ event: 'error', data: overload }]));
      const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });
      await res.text();
      statuses.push(res.status);
    }

    expect(statuses).toEqual([502, 502, 502, 502]);
  });

  it('answers a response that completes with neither output nor usage with 502', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        {
          event: 'response.created',
          data: { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        },
        {
          event: 'response.completed',
          data: { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
        },
      ])
    );

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { type: 'empty_upstream_response' } });
  });

  it('answers an upstream 400 that only says the model is at capacity with 502, keeping its body', async () => {
    const capacity = '{"error":{"message":"The selected model is at capacity.","type":"invalid_request_error"}}';
    proxy.upstream.respondWith((res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(capacity);
    });

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(502);
    expect(await res.text()).toBe(capacity);
  });

  it('keeps streaming an error that arrives after output has started', async () => {
    const events = [
      ...CHATGPT_STREAM.slice(0, 2),
      { event: 'error', data: { type: 'error', error: { type: 'server_error', message: 'Stream broke.' } } },
    ];
    proxy.upstream.respondWith(respondWithEventStream(events));

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
    );
  });

  it('buffers the stream into the completed response for a caller that does not stream', async () => {
    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(COMPLETED_RESPONSE);
  });

  it('answers 502 to a caller that does not stream when the stream stops before the response completes', async () => {
    proxy.upstream.respondWith(respondWithEventStream(CHATGPT_STREAM.slice(0, 2)));

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'stream_incomplete' } });
  });

  it('answers a failure after output with an HTTP error to a caller that does not stream', async () => {
    proxy.upstream.respondWith(
      respondWithEventStream([
        ...CHATGPT_STREAM.slice(0, 2),
        { event: 'error', data: { type: 'error', error: { type: 'server_error', message: 'Stream broke.' } } },
      ])
    );

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { type: 'server_error', message: 'Stream broke.' } });
  });

  it('answers 502 to a stream that ends with only its preamble', async () => {
    proxy.upstream.respondWith(respondWithEventStream(CHATGPT_STREAM.slice(0, 1)));

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(502);
  });

  it('passes an upstream error through with its status, content type and body text', async () => {
    const upstreamError = '{"detail":"You have hit your usage limit."}';
    proxy.upstream.respondWith((res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(upstreamError);
    });

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, stream: true });

    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(upstreamError);
  });

  it('passes a plain-text upstream error through as the same string', async () => {
    proxy.upstream.respondWith((res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream connect error');
    });

    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });

    expect(res.status).toBe(503);
    expect(await res.text()).toBe('upstream connect error');
  });
});

describe('body cap', () => {
  const oversizedBody = JSON.stringify({ model: 'gpt-5.6-sol', input: 'x'.repeat(MAX_BODY_BYTES) });

  it('answers 413 when the declared body length is over the cap', async () => {
    const res = await proxy.sendLikeBifrost(oversizedBody);

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { type: 'payload_too_large' } });
    expect(proxy.upstream.requests).toHaveLength(0);
  });

  it('drops the connection without calling ChatGPT when a chunked body grows over the cap', async () => {
    const outcome = new Promise<string>((resolve) => {
      const req = request(
        `${proxy.baseUrl}/v1/responses`,
        { method: 'POST', headers: { authorization: BIFROST_AUTHORIZATION, 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          resolve(`status ${res.statusCode}`);
        }
      );
      req.on('error', () => resolve('connection dropped'));
      req.write(oversizedBody.slice(0, MAX_BODY_BYTES / 2));
      req.end(oversizedBody.slice(MAX_BODY_BYTES / 2));
    });

    expect(await outcome).toBe('connection dropped');
    expect(proxy.upstream.requests).toHaveLength(0);
  });
});

describe('models', () => {
  it('lists the ChatGPT models in the OpenAI list shape', async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: BIFROST_AUTHORIZATION } });
    const body = (await res.json()) as { object: string; data: { id: string; object: string }[] };

    expect(body.object).toBe('list');
    expect(body.data.map((model) => model.id)).toContain('gpt-5.6-sol');
    expect(body.data.every((model) => model.object === 'model')).toBe(true);
  });
});
