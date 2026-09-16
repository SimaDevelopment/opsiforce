import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from './platform.ts';
import { runtimeClient, runtimeFetch } from './runtime.ts';

let origin = '';
let reads = 0;
let writes = 0;
let seenUrl = '';
let seenBody = '';
let seenAuthorization = '';
const server = createServer(async (req, res) => {
  seenUrl = req.url ?? '';
  seenAuthorization = req.headers.authorization ?? '';
  if (seenUrl.endsWith('/stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    return;
  }
  if (seenUrl.endsWith('/retry')) {
    if (req.method === 'GET' && ++reads > 1) { res.end('{}'); return; }
    if (req.method === 'POST') writes += 1;
    res.writeHead(503, { 'retry-after': '0' });
    res.end('{}');
    return;
  }
  if (seenUrl.endsWith('/redirect')) {
    res.writeHead(302, { location: 'https://foreign.test' });
    res.end();
    return;
  }
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part);
  seenBody = Buffer.concat(parts).toString();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'msg_original', delivery: 'steer' }));
});
before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function setup(onRetryAfter?: (delay: number) => void) {
  const platform = new Platform({ origin, token: 'test-token', onRetryAfter });
  const connection = { baseUrl: '/api/proxy/env', openapiUrl: '/api/proxy/env/openapi.json', sessionId: 'ses_test', build: null };
  return { fetch: runtimeFetch(platform, connection), client: runtimeClient(platform, connection) };
}

test('the pinned generated client sends authenticated native prompts through the prefix', async () => {
  await setup().client.session.prompt({ sessionID: 'ses_test', id: 'msg_original', text: 'Hello' });
  assert.equal(seenAuthorization, 'Bearer test-token');
  assert.equal(seenUrl, '/api/proxy/env/api/session/ses_test/prompt');
  assert.deepEqual(JSON.parse(seenBody), { id: 'msg_original', text: 'Hello' });
});

test('Request, URL and string inputs preserve query/body and do not double-prefix', async () => {
  const adapter = setup().fetch;
  await adapter(new Request(`${origin}/api/query?order=asc`, { method: 'POST', body: 'payload' }));
  assert.equal(seenUrl, '/api/proxy/env/api/query?order=asc');
  assert.equal(seenBody, 'payload');
  await adapter(new URL(`${origin}/api/proxy/env/api/query?limit=1`));
  assert.equal(seenUrl, '/api/proxy/env/api/query?limit=1');
  await adapter(`${origin}/api/query`);
  assert.equal(seenUrl, '/api/proxy/env/api/query');
});

test('credentials cannot reach another origin or follow redirects', async () => {
  const adapter = setup().fetch;
  assert.throws(() => adapter('https://foreign.test/api/session'), /Refusing/);
  await assert.rejects(adapter(`${origin}/redirect`));
});

test('observes retry guidance before client conversion and retries only reads', async () => {
  const delays: number[] = [];
  const adapter = setup((delay) => delays.push(delay)).fetch;
  assert.equal((await adapter(`${origin}/retry`)).status, 200);
  assert.equal(reads, 2);
  assert.equal((await adapter(`${origin}/retry`, { method: 'POST' })).status, 503);
  assert.equal(writes, 1);
  assert.deepEqual(delays, [0, 0]);
});

test('streams immediately and cancellation closes the pending body', async () => {
  const controller = new AbortController();
  const response = await setup().fetch(`${origin}/stream`, { signal: controller.signal });
  const reader = response.body?.getReader();
  assert.ok(reader);
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.abort();
  await assert.rejects(reader.read());
});
