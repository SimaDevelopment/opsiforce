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
  it('defaults instructions to an empty string, turns storage off, forces streaming and drops max_output_tokens', async () => {
    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN, max_output_tokens: 512 });
    await res.text();

    expect(proxy.upstream.requests).toHaveLength(1);
    expect(proxy.upstream.requests[0]?.body).toEqual({
      model: 'gpt-5.6-sol',
      input: USER_TURN,
      instructions: '',
      store: false,
      stream: true,
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

  it('buffers the stream into the completed response for a caller that does not stream', async () => {
    const res = await proxy.sendLikeBifrost({ model: 'gpt-5.6-sol', input: USER_TURN });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(COMPLETED_RESPONSE);
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
