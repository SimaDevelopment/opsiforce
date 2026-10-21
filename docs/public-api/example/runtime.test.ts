import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from './platform.ts';
import { promptForOutcome, runtimeClient } from './runtime.ts';

const connection = { baseUrl: '/api/proxy/env', openapiUrl: '/api/proxy/env/openapi.json', sessionId: 'ses_test', build: '2.1.2' };

let origin = '';
let reads = 0;
let writes = 0;
let seenUrl = '';
let seenBody = '';
let seenAuthorization = '';
let stream: ServerResponse | undefined;
let turnEvents: object[] = [];

const server = createServer(async (req, res) => {
  seenUrl = req.url ?? '';
  seenAuthorization = req.headers.authorization ?? '';
  if (seenUrl === '/api/proxy/env/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send(res, { id: 'evt_0', type: 'server.connected', data: {} });
    stream = res;
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
  const { id } = JSON.parse(seenBody || '{}') as { id?: string };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: { id: id ?? 'msg_original', sessionID: 'ses_test', type: 'user', delivery: 'steer', time: { created: 1 }, payload: {} } }));
  if (stream) for (const event of turnEvents) send(stream, event);
});

function send(res: ServerResponse, event: object): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function event(type: string, data: object): object {
  return { id: `evt_${type}`, created: 1, type, data };
}

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  stream = undefined;
  turnEvents = [];
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function platform(onRetryAfter?: (delay: number) => void): Platform {
  return new Platform({ origin, token: 'test-token', onRetryAfter });
}

test('the pinned client sends authenticated native prompts under the runtime prefix', async () => {
  const admitted = await runtimeClient(platform(), connection).session.prompt({ sessionID: 'ses_test', id: 'msg_original', text: 'Hello' });
  assert.equal(admitted.id, 'msg_original');
  assert.equal(seenAuthorization, 'Bearer test-token');
  assert.equal(seenUrl, '/api/proxy/env/api/session/ses_test/prompt');
  assert.deepEqual(JSON.parse(seenBody), { id: 'msg_original', text: 'Hello' });
});

test("a prompt's outcome is the first execution event after its own delivery", async () => {
  turnEvents = [
    event('session.execution.succeeded', { sessionID: 'ses_test' }),
    event('session.inbox.delivered', { sessionID: 'ses_test', inboxID: 'msg_someone_else' }),
    event('session.inbox.delivered', { sessionID: 'ses_test', inboxID: 'msg_mine' }),
    event('session.execution.succeeded', { sessionID: 'ses_other' }),
    event('session.execution.failed', { sessionID: 'ses_test', error: { type: 'provider', message: 'quota exceeded' } }),
    event('session.execution.succeeded', { sessionID: 'ses_test' }),
  ];
  const seen: string[] = [];

  const { admitted, turn } = await promptForOutcome(
    runtimeClient(platform(), connection),
    { sessionID: 'ses_test', id: 'msg_mine', text: 'Hello' },
    { signal: new AbortController().signal, onEvent: (received) => seen.push(received.type) }
  );

  assert.equal(admitted.id, 'msg_mine');
  assert.deepEqual(turn, { outcome: 'failed', error: { type: 'provider', message: 'quota exceeded' } });
  assert.deepEqual(seen, [
    'session.execution.succeeded',
    'session.inbox.delivered',
    'session.inbox.delivered',
    'session.execution.failed',
  ]);
});

test('an interrupted turn reports why it stopped', async () => {
  turnEvents = [
    event('session.inbox.delivered', { sessionID: 'ses_test', inboxID: 'msg_mine' }),
    event('session.execution.interrupted', { sessionID: 'ses_test', reason: 'user' }),
  ];

  const { turn } = await promptForOutcome(
    runtimeClient(platform(), connection),
    { sessionID: 'ses_test', id: 'msg_mine', text: 'Hello' },
    { signal: new AbortController().signal }
  );

  assert.deepEqual(turn, { outcome: 'interrupted', reason: 'user' });
});

test('an ambiguous admission is replayed with the same id and body', async () => {
  turnEvents = [
    event('session.inbox.delivered', { sessionID: 'ses_test', inboxID: 'msg_mine' }),
    event('session.execution.succeeded', { sessionID: 'ses_test' }),
  ];
  const bodies: string[] = [];

  const { turn } = await promptForOutcome(
    runtimeClient(platform(), connection),
    { sessionID: 'ses_test', id: 'msg_mine', text: 'Hello' },
    {
      signal: new AbortController().signal,
      admit: async (send) => {
        await send();
        bodies.push(seenBody);
        const replayed = await send();
        bodies.push(seenBody);
        return replayed;
      },
    }
  );

  assert.deepEqual(turn, { outcome: 'succeeded' });
  assert.deepEqual(bodies.map((body) => JSON.parse(body)), [
    { id: 'msg_mine', text: 'Hello' },
    { id: 'msg_mine', text: 'Hello' },
  ]);
});

test('cancelling stops waiting for the outcome with the caller\'s reason', async () => {
  turnEvents = [event('session.inbox.delivered', { sessionID: 'ses_test', inboxID: 'msg_mine' })];
  const run = new AbortController();

  const waiting = promptForOutcome(
    runtimeClient(platform(), connection),
    { sessionID: 'ses_test', id: 'msg_mine', text: 'Hello' },
    { signal: run.signal, onEvent: () => setImmediate(() => run.abort(new Error('stopped by the operator'))) }
  );

  await assert.rejects(waiting, /stopped by the operator/);
});

test('credentials cannot reach another origin or follow redirects', async () => {
  const client = platform();
  await assert.rejects(client.fetch(new Request('https://foreign.test/api/session')), /Refusing/);
  await assert.rejects(client.fetch(new Request(`${origin}/redirect`)));
});

test('observes retry guidance before client conversion and retries only reads', async () => {
  const delays: number[] = [];
  const client = platform((delay) => delays.push(delay));
  assert.equal((await client.fetch(new Request(`${origin}/retry`))).status, 200);
  assert.equal(reads, 2);
  assert.equal((await client.fetch(new Request(`${origin}/retry`, { method: 'POST' }))).status, 503);
  assert.equal(writes, 1);
  assert.deepEqual(delays, [0, 0]);
});
