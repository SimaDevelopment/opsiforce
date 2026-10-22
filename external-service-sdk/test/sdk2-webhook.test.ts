import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';

import type {
  DeliveredEvent,
  DeliveryResult,
  DeliveryResultKind,
  WebhookHandler,
} from '@opsiforce/external-service-sdk';
import {
  createMemoryServiceState,
  createServicePipeline,
  gatewayEvents,
  mintCallerIdentity,
  withAtomicUpdate,
  type CallRow,
  type CountEntry,
} from '@opsiforce/external-service-sdk/server';
import { staticConfigurations, testServiceCaller } from '@opsiforce/external-service-sdk/testing';

import { definedWith, githubManifest, privateKey, serviceConfiguration } from './support/sdk2.ts';

const gatewayKey = 'gw-webhook-pod-key-0123456789';

const issueOpened: DeliveredEvent = {
  type: 'issue.opened',
  key: 'delivery-1',
  occurredAt: '2026-10-17T09:30:00.000Z',
  data: { number: 7 },
};

interface Delivered {
  event: DeliveredEvent;
  to: readonly string[];
  callerIdentity: string | undefined;
}

interface PodOptions {
  webhook?: WebhookHandler;
  manifest?: Record<string, unknown>;
  results?: Record<string, DeliveryResultKind>;
}

function pod(options: PodOptions) {
  const rows: CallRow[] = [];
  const counts: CountEntry[] = [];
  const delivered: Delivered[] = [];
  const defined = definedWith([], {
    ...(options.webhook === undefined ? {} : { webhook: options.webhook }),
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
  });
  const pipeline = createServicePipeline(defined, {
    gatewayKey,
    configurations: staticConfigurations({ manifest: defined.manifest, serviceConfiguration }),
    upstreams: {
      runsCredentials: false,
      send: () => Promise.reject(new Error('no upstream in these tests')),
    },
    state: withAtomicUpdate(createMemoryServiceState()),
    records: { call: (row) => rows.push(row), count: (entry) => counts.push(entry) },
    events: {
      async deliver(event, to, callerIdentity): Promise<DeliveryResult[]> {
        delivered.push({ event, to, callerIdentity });
        return to.map((projectEnvironmentId) => ({
          projectEnvironmentId,
          result: options.results?.[projectEnvironmentId] ?? 'stored',
        }));
      },
    },
  });
  const platformIdentity = mintCallerIdentity({ kind: 'platform', tenantId: testServiceCaller.tenantId }, gatewayKey);
  const send = (target: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('x-opsiforce-caller')) headers.set('x-opsiforce-caller', platformIdentity);
    headers.set('host', 'service.local');
    const body = init.body === undefined ? null : (new Response(init.body).body as ReadableStream<Uint8Array>);
    return pipeline.answer({ method: init.method ?? 'POST', target, headers, body });
  };
  return { pipeline, rows, counts, delivered, send, platformIdentity };
}

test('the webhook handler gets the provider request untouched below the Webhook address, any method', async () => {
  const seen: unknown[] = [];
  const service = pod({
    webhook: async (request, ctx) => {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        signature: request.headers.get('x-hub-signature-256'),
        authorization: request.headers.get('authorization'),
        callerIdentity: request.headers.get('x-opsiforce-caller'),
        body: await request.text(),
        caller: ctx.caller.kind,
        projectEnvironment: ctx.caller.projectEnvironmentId ?? null,
      });
      return new Response('challenge-42', { headers: { 'content-type': 'text/plain' } });
    },
  });

  const answer = await service.send('/.well-known/opsiforce/webhook/meta/verify?hub.challenge=challenge-42', {
    method: 'GET',
    headers: { 'x-hub-signature-256': 'sha256=abc', authorization: 'Bearer provider-token' },
  });
  const posted = await service.send('/.well-known/opsiforce/webhook', {
    method: 'PUT',
    body: '{"action":"opened"}',
  });

  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), 'challenge-42');
  assert.equal(posted.status, 200);
  await posted.arrayBuffer();
  assert.deepEqual(seen, [
    {
      method: 'GET',
      path: '/meta/verify',
      query: '?hub.challenge=challenge-42',
      signature: 'sha256=abc',
      authorization: 'Bearer provider-token',
      callerIdentity: null,
      body: '',
      caller: 'platform',
      projectEnvironment: null,
    },
    {
      method: 'PUT',
      path: '/',
      query: '',
      signature: null,
      authorization: null,
      callerIdentity: null,
      body: '{"action":"opened"}',
      caller: 'platform',
      projectEnvironment: null,
    },
  ]);
  assert.deepEqual(
    service.rows.map((row) => ({ route: row.route, outcome: row.outcome, kind: row.callerKind, path: row.path })),
    [
      { route: 'webhook', outcome: 'handled', kind: 'platform', path: '/.well-known/opsiforce/webhook/meta/verify' },
      { route: 'webhook', outcome: 'handled', kind: 'platform', path: '/.well-known/opsiforce/webhook' },
    ]
  );
});

test('a delivery from the webhook carries its Caller identity and the default answer is 200 when every receiver took it', async () => {
  const service = pod({
    webhook: async (_request, ctx) => {
      const results = await ctx.service.deliver(issueOpened, { to: ['pe-1', 'pe-2'] });
      ctx.note({ results: results.map((result) => result.result) });
    },
    results: { 'pe-2': 'duplicate' },
  });

  const answer = await service.send('/.well-known/opsiforce/webhook', { body: '{}' });

  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { received: true });
  assert.equal(service.delivered.length, 1);
  assert.deepEqual(service.delivered[0]?.to, ['pe-1', 'pe-2']);
  assert.equal(service.delivered[0]?.callerIdentity, service.platformIdentity);
  assert.deepEqual(
    service.rows.map((row) => ({ outcome: row.outcome, reason: row.reason, notes: row.notes })),
    [
      {
        outcome: 'handled',
        reason: 'issue.opened → 1 environment, 1 already had it',
        notes: { results: ['stored', 'duplicate'] },
      },
    ]
  );
  assert.deepEqual(
    service.counts.map((count) => ({
      name: count.name,
      label: count.label,
      n: count.n,
      projectEnvironmentId: count.projectEnvironmentId,
    })),
    [{ name: 'events', label: 'Events', n: 1, projectEnvironmentId: 'pe-1' }]
  );
});

test('a delivery the webhook refuses is answered as the handler says and its row names the status', async () => {
  const service = pod({
    webhook: async (request) =>
      request.headers.get('x-signature') === 'good'
        ? undefined
        : new Response('Invalid webhook signature', { status: 401 }),
  });

  const refused = await service.send('/.well-known/opsiforce/webhook', { body: '{}' });
  const ignored = await service.send('/.well-known/opsiforce/webhook', {
    body: '{}',
    headers: { 'x-signature': 'good' },
  });

  assert.equal(refused.status, 401);
  assert.equal(await refused.text(), 'Invalid webhook signature');
  assert.equal(ignored.status, 200);
  await ignored.arrayBuffer();
  assert.deepEqual(
    service.rows.map((row) => ({ outcome: row.outcome, reason: row.reason, status: row.status })),
    [
      { outcome: 'handled', reason: 'the webhook answered 401', status: 401 },
      { outcome: 'handled', reason: null, status: 200 },
    ]
  );
});

test('an over-cap receiver makes the default answer 503 and the row failed, while the others still count', async () => {
  const service = pod({
    webhook: async (_request, ctx) => {
      await ctx.service.deliver(issueOpened, { to: ['pe-1', 'pe-3'] });
    },
    results: { 'pe-3': 'over-cap' },
  });

  const answer = await service.send('/.well-known/opsiforce/webhook', { body: '{}' });

  assert.equal(answer.status, 503);
  assert.equal(answer.headers.get('retry-after'), '60');
  await answer.arrayBuffer();
  assert.deepEqual(
    service.rows.map((row) => ({ outcome: row.outcome, reason: row.reason, status: row.status })),
    [{ outcome: 'failed', reason: 'pe-3 over the Event cap', status: 503 }]
  );
  assert.deepEqual(
    service.counts.map((count) => count.projectEnvironmentId),
    ['pe-1']
  );
});

test('a receiver that is not connected also makes the default answer 503; a handler answer of its own is kept', async () => {
  const defaulted = pod({
    webhook: async (_request, ctx) => {
      await ctx.service.deliver(issueOpened, { to: ['pe-4'] });
    },
    results: { 'pe-4': 'not-connected' },
  });
  const own = pod({
    webhook: async (_request, ctx) => {
      await ctx.service.deliver(issueOpened, { to: ['pe-4'] });
      return Response.json({ ok: true });
    },
    results: { 'pe-4': 'not-connected' },
  });

  const defaultAnswer = await defaulted.send('/.well-known/opsiforce/webhook', { body: '{}' });
  const ownAnswer = await own.send('/.well-known/opsiforce/webhook', { body: '{}' });

  assert.equal(defaultAnswer.status, 503);
  assert.equal(ownAnswer.status, 200);
  await defaultAnswer.arrayBuffer();
  await ownAnswer.arrayBuffer();
  assert.deepEqual(
    [...defaulted.rows, ...own.rows].map((row) => ({ outcome: row.outcome, reason: row.reason })),
    [
      { outcome: 'failed', reason: 'pe-4 is not connected' },
      { outcome: 'failed', reason: 'pe-4 is not connected' },
    ]
  );
});

test('a service delivering outside a request sends no Caller identity and still counts stored Events', async () => {
  const service = pod({ webhook: () => undefined });

  const results = await service.pipeline.service.deliver(issueOpened, { to: ['pe-1'] });

  assert.deepEqual(results, [{ projectEnvironmentId: 'pe-1', result: 'stored' }]);
  assert.equal(service.delivered[0]?.callerIdentity, undefined);
  assert.deepEqual(
    service.counts.map((count) => [count.name, count.projectEnvironmentId]),
    [['events', 'pe-1']]
  );
});

test('the Webhook address answers only the platform and never reaches a Service route', async () => {
  const service = pod({ webhook: () => Response.json({ reached: true }) });
  const call = mintCallerIdentity({ ...testServiceCaller, kind: 'call' }, gatewayKey);

  const answer = await service.send('/.well-known/opsiforce/webhook', {
    body: '{}',
    headers: { 'x-opsiforce-caller': call },
  });

  assert.equal(answer.status, 404);
  assert.equal(answer.headers.get('opsiforce-outcome'), 'not supported');
});

test('a service without inbound, or without a webhook handler, has no Webhook address', async () => {
  const { inbound: _inbound, ...withoutInbound } = githubManifest();
  const noInbound = pod({ webhook: () => Response.json({ reached: true }), manifest: withoutInbound });
  const noHandler = pod({});

  for (const service of [noInbound, noHandler]) {
    const answer = await service.send('/.well-known/opsiforce/webhook', { body: '{}' });
    assert.equal(answer.status, 404);
    assert.equal(answer.headers.get('opsiforce-outcome'), 'not supported');
  }
});

test('a webhook answer holding a secret of the Service configuration is refused as failed', async () => {
  const service = pod({ webhook: () => new Response(`key ${privateKey}`) });

  const answer = await service.send('/.well-known/opsiforce/webhook', { body: '{}' });

  assert.equal(answer.status, 502);
  assert.equal(answer.headers.get('opsiforce-outcome'), 'failed');
});

interface ReceivedDelivery {
  path: string;
  authorization: string | undefined;
  callerIdentity: string | undefined;
  contentType: string;
  form: FormData;
}

async function gatewayAnswering(
  t: TestContext,
  answer: (received: ReceivedDelivery) => Response
): Promise<{ url: string; received: ReceivedDelivery[] }> {
  const received: ReceivedDelivery[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const contentType = request.headers['content-type'] ?? '';
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData();
    const delivery = {
      path: request.url ?? '',
      authorization: request.headers.authorization,
      callerIdentity: request.headers['x-opsiforce-caller'] as string | undefined,
      contentType,
      form,
    };
    received.push(delivery);
    const reply = answer(delivery);
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    response.end(Buffer.from(await reply.arrayBuffer()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/gateway`, received };
}

test('gatewayEvents posts one multipart Event with its files and reads the per-receiver results', async (t) => {
  const gateway = await gatewayAnswering(t, () =>
    Response.json({ results: [{ projectEnvironmentId: 'pe-1', result: 'stored' }] })
  );
  const events = gatewayEvents({ url: gateway.url, gatewayKey });

  const results = await events.deliver(
    {
      ...issueOpened,
      files: [{ name: 'log.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hello') }],
    },
    ['pe-1'],
    'caller-token'
  );

  assert.deepEqual(results, [{ projectEnvironmentId: 'pe-1', result: 'stored' }]);
  const [received] = gateway.received;
  assert.equal(received?.path, '/api/gateway/events');
  assert.equal(received?.authorization, `Bearer ${gatewayKey}`);
  assert.equal(received?.callerIdentity, 'caller-token');
  assert.match(received?.contentType ?? '', /^multipart\/form-data; boundary=/);
  assert.deepEqual(JSON.parse(String(received?.form.get('event'))), {
    type: 'issue.opened',
    key: 'delivery-1',
    occurredAt: '2026-10-17T09:30:00.000Z',
    data: { number: 7 },
    to: ['pe-1'],
    files: [{ part: 'file-0', name: 'log.txt', mimeType: 'text/plain' }],
  });
  const file = received?.form.get('file-0') as File;
  assert.equal(await file.text(), 'hello');
});

test('gatewayEvents throws on a refused delivery, naming the status and the problems', async (t) => {
  const gateway = await gatewayAnswering(t, () =>
    Response.json({ problems: ['type "nope" is not a declared Event type'] }, { status: 400 })
  );
  const events = gatewayEvents({ url: gateway.url, gatewayKey });

  await assert.rejects(
    events.deliver({ ...issueOpened, type: 'nope' }, ['pe-1']),
    /the Event delivery answered 400: .*not a declared Event type/
  );
  assert.equal(gateway.received[0]?.callerIdentity, undefined);
});
