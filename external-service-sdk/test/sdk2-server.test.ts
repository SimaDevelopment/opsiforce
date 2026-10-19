import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createGzip, gzipSync } from 'node:zlib';

import { allowAll, route, upstream, type Route } from '@opsiforce/external-service-sdk';
import {
  createServiceHttpServer,
  idleConnectionTimeoutMs,
  mintCallerIdentity,
} from '@opsiforce/external-service-sdk/server';
import { staticConfigurations, testServiceCaller } from '@opsiforce/external-service-sdk/testing';

import { definedWith, privateKey, projectConfiguration, serviceConfiguration } from './support/sdk2.ts';

const gatewayKey = 'gw-default-pod-key-0123456789';

async function listening(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => sockets.add(socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

async function upstreamServer(
  t: TestContext,
  answer: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void = (_request, response) =>
    response.end('upstream answer')
) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
    answer(request, response, body);
  });
  const port = await listening(t, server);
  return { seen, server, url: `http://127.0.0.1:${port}` };
}

async function serviceServer(t: TestContext, routes: (url: string) => Route[], upstreamUrl: string) {
  const { server } = createServiceHttpServer(definedWith(routes(upstreamUrl)), {
    gatewayKey,
    stateFile: join(mkdtempSync(join(tmpdir(), 'sdk2-state-')), 'service-state.db'),
    configurations: staticConfigurations({
      manifest: definedWith([]).manifest,
      serviceConfiguration,
      projectConfiguration,
    }),
  });
  return listening(t, server);
}

const identity = () => mintCallerIdentity({ ...testServiceCaller, kind: 'call' }, gatewayKey);

interface Answer {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer | string }
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { 'x-opsiforce-caller': identity(), ...options.headers },
      },
      async (incoming) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) });
      }
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

const credentialed = (url: string) =>
  upstream({
    name: 'rest',
    api: 'GitHub REST API',
    url,
    mount: '/api/v3',
    credentials: ({ serviceConfiguration: values }, outgoing) => ({
      headers: {
        authorization: `Bearer ${String((values.privateKey as { reveal(): string }).reveal())}`,
        'x-saw-host': outgoing.headers.get('host') ?? '',
      },
      query: { key: 'service-key' },
    }),
  });

test('the caller’s credentials, cookies, hop-by-hop headers and the Caller identity never reach the upstream', async (t) => {
  const github = await upstreamServer(t);
  const port = await serviceServer(
    t,
    (url) => [route('* /api/v3/**', { summary: 'Everything', allowedBy: [], to: credentialed(url), check: allowAll })],
    github.url
  );

  const answer = await send(port, {
    path: '/api/v3/user?key=caller-key&per_page=5',
    headers: {
      authorization: 'Bearer gw-caller-key',
      'proxy-authorization': 'Basic abc',
      cookie: 'session=1',
      connection: 'keep-alive, x-private',
      'x-private': 'hop',
      'x-kept': 'kept',
    },
  });

  assert.equal(answer.status, 200);
  const [seen] = github.seen;
  assert.equal(seen?.url, '/user?per_page=5&key=service-key');
  assert.equal(seen?.headers.authorization, `Bearer ${privateKey}`);
  assert.equal(seen?.headers['proxy-authorization'], undefined);
  assert.equal(seen?.headers.cookie, undefined);
  assert.equal(seen?.headers['x-private'], undefined);
  assert.equal(seen?.headers['x-opsiforce-caller'], undefined);
  assert.equal(seen?.headers['x-kept'], 'kept');
  assert.equal(seen?.headers.host, new URL(github.url).host);
  assert.equal(seen?.headers['x-saw-host'], new URL(github.url).host);
});

test('a safe path is forwarded byte for byte with the mount removed', async (t) => {
  const github = await upstreamServer(t);
  const port = await serviceServer(
    t,
    (url) => [
      route('* /api/v3/**', {
        summary: 'Everything',
        allowedBy: [],
        to: upstream({ name: 'rest', api: 'REST', url: `${url}/base`, mount: '/api/v3' }),
        check: allowAll,
      }),
    ],
    github.url
  );

  await send(port, { path: '/api/v3/repos/acme/a%20b/~x;y=1/caf%C3%A9?q=%41+b&flag' });
  await send(port, { path: '/api/v3' });

  assert.equal(github.seen[0]?.url, '/base/repos/acme/a%20b/~x;y=1/caf%C3%A9?q=%41+b&flag');
  assert.equal(github.seen[1]?.url, '/base');
});

test('answers pass untouched: status, headers, gzip bytes and error bodies', async (t) => {
  const gzipped = gzipSync('{"kind":"Status","code":409}');
  const github = await upstreamServer(t, (_request, response) => {
    response.writeHead(409, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'x-ratelimit-remaining': '42',
    });
    response.end(gzipped);
  });
  const port = await serviceServer(
    t,
    (url) => [route('* /api/v3/**', { summary: 'Everything', allowedBy: [], to: credentialed(url), check: allowAll })],
    github.url
  );

  const answer = await send(port, { path: '/api/v3/thing' });

  assert.equal(answer.status, 409);
  assert.equal(answer.headers['content-encoding'], 'gzip');
  assert.equal(answer.headers['x-ratelimit-remaining'], '42');
  assert.equal(answer.headers['opsiforce-outcome'], undefined);
  assert.deepEqual(answer.body, gzipped);
});

test('a streamed answer reaches the caller as each chunk is sent', async (t) => {
  let finish: () => void = () => undefined;
  const github = await upstreamServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    finish = () => response.end('data: last\n\n');
  });
  const port = await serviceServer(
    t,
    (url) => [
      route('GET /api/v3/events', { summary: 'Events', allowedBy: [], to: credentialed(url), check: allowAll }),
    ],
    github.url
  );

  const first = await new Promise<string>((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path: '/api/v3/events', headers: { 'x-opsiforce-caller': identity() } },
      (incoming) => {
        incoming.once('data', (chunk: Buffer) => {
          resolve(chunk.toString());
          finish();
          incoming.resume();
        });
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });

  assert.equal(first, 'data: first\n\n');
});

test('a chunked upload nobody reads is streamed to the upstream as sent', async (t) => {
  const github = await upstreamServer(t);
  const port = await serviceServer(
    t,
    (url) => [
      route('POST /api/v3/upload', {
        summary: 'Upload',
        allowedBy: [],
        to: credentialed(url),
        check: allowAll,
        bodyLimit: 4,
      }),
    ],
    github.url
  );

  const answer = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/v3/upload',
        headers: { 'x-opsiforce-caller': identity() },
      },
      (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
      }
    );
    outgoing.on('error', reject);
    outgoing.write('first chunk;');
    setTimeout(() => outgoing.end('second chunk'), 20);
  });

  assert.equal(answer, 200);
  assert.equal(github.seen[0]?.headers['transfer-encoding'], 'chunked');
  assert.equal(github.seen[0]?.body.toString(), 'first chunk;second chunk');
});

function upgradeRequest(port: number, path: string, callerIdentity: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: echo',
          `X-Opsiforce-Caller: ${callerIdentity}`,
          '',
          '',
        ].join('\r\n')
      );
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('\r\n\r\n') && received.startsWith('HTTP/1.1 101') && !received.includes('ping')) {
        socket.write('ping');
      }
      if (received.includes('pong:ping') || (!received.startsWith('HTTP/1.1 101') && received.includes('}'))) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
  });
}

test('an Upgrade passes through a proxy route and both directions stream', async (t) => {
  const github = await upstreamServer(t);
  github.server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
    socket.on('data', (chunk) => socket.write(`pong:${chunk.toString()}`));
  });
  const port = await serviceServer(
    t,
    (url) => [
      route('GET /api/v3/repos/:owner/:repo/through', {
        summary: 'Filtered',
        allowedBy: [],
        to: credentialed(url),
        check: allowAll,
        through: (_request, _ctx, forward) => forward(),
      }),
      route('GET /api/v3/**', { summary: 'Everything', allowedBy: [], to: credentialed(url), check: allowAll }),
    ],
    github.url
  );

  const upgraded = await upgradeRequest(port, '/api/v3/exec', identity());
  const refused = await upgradeRequest(port, '/api/v3/repos/acme/web/through', identity());
  const unidentified = await upgradeRequest(port, '/api/v3/exec', 'bad');

  assert.match(upgraded, /^HTTP\/1\.1 101/);
  assert.match(upgraded, /pong:ping/);
  assert.match(refused, /^HTTP\/1\.1 404/);
  assert.match(refused, /opsiforce-outcome: not supported/i);
  assert.match(unidentified, /^HTTP\/1\.1 401/);
});

test('the server refuses a request without a Caller identity', async (t) => {
  const github = await upstreamServer(t);
  const port = await serviceServer(
    t,
    (url) => [route('* /**', { summary: 'Everything', allowedBy: [], to: credentialed(url), check: allowAll })],
    github.url
  );

  const answer = await send(port, { path: '/api/v3/user', headers: { 'x-opsiforce-caller': '' } });

  assert.equal(answer.status, 401);
  assert.equal(answer.headers['opsiforce-outcome'], 'unidentified');
  assert.equal(github.seen.length, 0);
});

test('the server never times a request out and keeps an idle connection longer than the Gate does', () => {
  const gateIdleConnectionTimeoutMs = 60_000;
  const { server } = createServiceHttpServer(definedWith([]), {
    gatewayKey,
    stateFile: join(mkdtempSync(join(tmpdir(), 'sdk2-state-')), 'service-state.db'),
  });

  assert.equal(server.requestTimeout, 0);
  assert.equal(server.keepAliveTimeout, idleConnectionTimeoutMs);
  assert.ok(server.keepAliveTimeout > gateIdleConnectionTimeoutMs);
  assert.ok(server.headersTimeout > server.keepAliveTimeout);
});

test('service.webhookUrl is the Webhook address the platform gives the pod in SERVICE_WEBHOOK_URL', (t) => {
  const address = 'https://opsiforce.test/api/external-services/webhooks/service-1/development';
  const previous = process.env.SERVICE_WEBHOOK_URL;
  process.env.SERVICE_WEBHOOK_URL = address;
  t.after(() => {
    if (previous === undefined) delete process.env.SERVICE_WEBHOOK_URL;
    else process.env.SERVICE_WEBHOOK_URL = previous;
  });
  const stateFile = join(mkdtempSync(join(tmpdir(), 'sdk2-state-')), 'service-state.db');

  assert.equal(createServiceHttpServer(definedWith([]), { gatewayKey, stateFile }).service.webhookUrl, address);
  assert.equal(
    createServiceHttpServer(definedWith([]), { gatewayKey, stateFile, webhookUrl: 'https://other.test/hook' }).service
      .webhookUrl,
    'https://other.test/hook'
  );
});

test('a body cut off at its limit while more of it is still arriving leaves the server answering', async (t) => {
  const github = await upstreamServer(t);
  const port = await serviceServer(
    t,
    (url) => [
      route('POST /api/v3/upload', {
        summary: 'Upload',
        allowedBy: [],
        to: credentialed(url),
        check: async (request, ctx) => {
          await request.arrayBuffer();
          return ctx.allow();
        },
        bodyLimit: 1024,
      }),
    ],
    github.url
  );

  const cutOff = await send(port, { method: 'POST', path: '/api/v3/upload', body: Buffer.alloc(4 * 1024 * 1024) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = await send(port, { method: 'POST', path: '/api/v3/upload', body: 'small' });

  assert.equal(cutOff.status, 413);
  assert.equal(next.status, 200);
  assert.equal(github.seen.length, 1);
});

test('a caller that hangs up during a decoded streamed answer stops the upstream and leaves the server answering', async (t) => {
  let upstreamClosed: () => void = () => undefined;
  const upstreamGone = new Promise<void>((resolve) => (upstreamClosed = resolve));
  const github = await upstreamServer(t, (request, response) => {
    if (request.url?.startsWith('/archive') !== true) {
      response.end('upstream answer');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' });
    const gzip = createGzip();
    gzip.pipe(response);
    const timer = setInterval(() => gzip.write(randomBytes(256 * 1024)), 1);
    response.on('close', () => {
      clearInterval(timer);
      upstreamClosed();
    });
  });
  const port = await serviceServer(
    t,
    (url) => [
      route('GET /api/v3/**', {
        summary: 'Everything',
        allowedBy: [],
        to: credentialed(url),
        check: allowAll,
        through: (request, _ctx, send) => send(request),
      }),
    ],
    github.url
  );

  await new Promise<void>((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port, path: '/api/v3/archive', headers: { 'x-opsiforce-caller': identity() } },
      (incoming) => {
        incoming.once('data', () => {
          outgoing.destroy();
          resolve();
        });
      }
    );
    outgoing.on('error', () => undefined);
    outgoing.end();
    setTimeout(() => reject(new Error('no answer arrived')), 5000).unref();
  });
  await upstreamGone;
  const next = await send(port, { path: '/api/v3/user' });

  assert.equal(next.status, 200);
  assert.equal(next.body.toString(), 'upstream answer');
});

test('a through step that stops reading a decoded answer early leaves the server answering', async (t) => {
  const github = await upstreamServer(t, (request, response) => {
    if (request.url?.startsWith('/archive') !== true) {
      response.end('upstream answer');
      return;
    }
    response.writeHead(200, { 'content-encoding': 'gzip' });
    response.end(gzipSync(randomBytes(4 * 1024 * 1024)));
  });
  const port = await serviceServer(
    t,
    (url) => [
      route('GET /api/v3/**', {
        summary: 'Everything',
        allowedBy: [],
        to: credentialed(url),
        check: allowAll,
        through: async (request, _ctx, send) => {
          const answer = await send(request);
          if (!request.url.endsWith('/archive') || answer.body === null) return answer;
          const reader = answer.body.getReader();
          await new Promise((resolve) => setTimeout(resolve, 20));
          const first = await reader.read();
          await reader.cancel();
          return new Response(`first ${first.value?.byteLength ?? 0} bytes`);
        },
      }),
    ],
    github.url
  );

  const firstBytes = await send(port, { path: '/api/v3/archive' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const next = await send(port, { path: '/api/v3/user' });

  assert.equal(firstBytes.status, 200);
  assert.match(firstBytes.body.toString(), /^first \d+ bytes$/);
  assert.equal(next.body.toString(), 'upstream answer');
});
