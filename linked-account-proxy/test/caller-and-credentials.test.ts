import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BIFROST_AUTHORIZATION,
  CALLER_SECRET,
  LINKED_ACCOUNT,
  SERVICE_TOKEN,
  respondWithEventStream,
  startLinkedAccountProxy,
} from './harness.ts';
import type { RunningProxy } from './harness.ts';

const COMPLETED = { id: 'resp_1', object: 'response', status: 'completed', output: [] };
const CHATGPT_STREAM = [{ event: 'response.completed', data: { type: 'response.completed', response: COMPLETED } }];
const REQUEST = { model: 'gpt-5.6-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }] };

let proxy: RunningProxy;

beforeEach(async () => {
  proxy = await startLinkedAccountProxy({ maxBodyBytes: 64 * 1024 });
  proxy.upstream.respondWith(respondWithEventStream(CHATGPT_STREAM));
});

afterEach(async () => {
  await proxy.stop();
});

function upstreamTokens(): Array<string | undefined> {
  return proxy.upstream.requests.map((request) => request.headers.authorization);
}

function answerUnauthorizedTimes(times: number): void {
  let calls = 0;
  const stream = respondWithEventStream(CHATGPT_STREAM);
  proxy.upstream.respondWith((res) => {
    calls += 1;
    if (calls > times) return stream(res);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"detail":"token expired"}');
  });
}

describe('caller auth', () => {
  it('resolves the caller from its lap_ key through the backend with the service token', async () => {
    const res = await proxy.sendLikeBifrost(REQUEST);

    expect(res.status).toBe(200);
    expect(proxy.backend.requests).toEqual([
      { serviceToken: SERVICE_TOKEN, body: { caller_secret: CALLER_SECRET, force_refresh: false } },
    ]);
    expect(upstreamTokens()).toEqual([`Bearer ${LINKED_ACCOUNT.accessToken}`]);
  });

  it('answers 401 to an unknown lap_ key without calling ChatGPT', async () => {
    const res = await proxy.sendLikeBifrost(REQUEST, 'Bearer lap_somebody-else');

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { type: 'unknown_caller' } });
    expect(proxy.upstream.requests).toHaveLength(0);
  });

  it('answers 401 to a request without a lap_ key without asking the backend', async () => {
    const responses = await Promise.all([
      proxy.sendLikeBifrost(REQUEST, 'Bearer sk-not-a-caller-secret'),
      fetch(`${proxy.baseUrl}/v1/responses`, { method: 'POST', body: JSON.stringify(REQUEST) }),
    ]);

    expect(responses.map((res) => res.status)).toEqual([401, 401]);
    expect(proxy.backend.requests).toHaveLength(0);
    expect(proxy.upstream.requests).toHaveLength(0);
  });
});

describe('token cache', () => {
  it('asks the backend once and serves later requests from the cached token', async () => {
    for (let request = 0; request < 3; request += 1) {
      expect((await proxy.sendLikeBifrost(REQUEST)).status).toBe(200);
    }

    expect(proxy.backend.requests).toHaveLength(1);
    expect(proxy.upstream.requests).toHaveLength(3);
  });

  it('keeps serving from the cached token while the backend is down', async () => {
    expect((await proxy.sendLikeBifrost(REQUEST)).status).toBe(200);
    proxy.backend.becomeUnreachable();

    expect((await proxy.sendLikeBifrost(REQUEST)).status).toBe(200);
  });

  it('asks the backend again for a token within 5 minutes of its expiry', async () => {
    proxy.backend.expireTokensIn(4 * 60 * 1000);

    await proxy.sendLikeBifrost(REQUEST);
    await proxy.sendLikeBifrost(REQUEST);

    expect(proxy.backend.requests).toHaveLength(2);
  });
});

describe('an upstream 401', () => {
  it('is retried once with a force-refreshed token', async () => {
    answerUnauthorizedTimes(1);

    const res = await proxy.sendLikeBifrost(REQUEST);

    expect(res.status).toBe(200);
    expect(proxy.backend.requests.map((request) => request.body.force_refresh)).toEqual([false, true]);
    expect(upstreamTokens()).toEqual([
      `Bearer ${LINKED_ACCOUNT.accessToken}`,
      `Bearer ${proxy.backend.refreshedTokens()[0]}`,
    ]);
  });

  it('is passed through when the refreshed token is refused too, with no second retry', async () => {
    answerUnauthorizedTimes(2);

    const res = await proxy.sendLikeBifrost(REQUEST);

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"detail":"token expired"}');
    expect(proxy.upstream.requests).toHaveLength(2);
    expect(proxy.backend.requests.filter((request) => request.body.force_refresh === true)).toHaveLength(1);
  });

  it('leaves the refreshed token in the cache for the next request', async () => {
    answerUnauthorizedTimes(1);
    await proxy.sendLikeBifrost(REQUEST);

    await proxy.sendLikeBifrost(REQUEST);

    expect(proxy.backend.requests).toHaveLength(2);
    expect(upstreamTokens().at(-1)).toBe(`Bearer ${proxy.backend.refreshedTokens()[0]}`);
  });
});

describe('models', () => {
  it("lists the adapter's fixed ChatGPT models without the retired gpt-5.4 ones, never asking ChatGPT", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: BIFROST_AUTHORIZATION } });
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((model) => model.id);

    expect(res.status).toBe(200);
    expect(ids).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-sol-fast',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6.1-sol-fast',
      'gpt-5.5',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'codex-auto-review',
    ]);
    expect(proxy.upstream.requests).toHaveLength(0);
  });

  it('answers 401 to an unknown caller', async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/models`, { headers: { authorization: 'Bearer lap_unknown' } });

    expect(res.status).toBe(401);
  });
});
