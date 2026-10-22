import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import { allowAll, route, upstream, type Route, type ServiceDefinition } from '@opsiforce/external-service-sdk';
import {
  createFileServiceRecords,
  createServiceHttpServer,
  mintCallerIdentity,
} from '@opsiforce/external-service-sdk/server';
import { staticConfigurations, testServiceCaller } from '@opsiforce/external-service-sdk/testing';

import { definedWith, projectConfiguration, serviceConfiguration } from './support/sdk2.ts';

const gatewayKey = 'gw-records-pod-key-0123456789';

interface StoredCall {
  request_id: string;
  time: string;
  caller_kind: string;
  project_id: string | null;
  project_environment_id: string | null;
  environment: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: string;
  reason: string | null;
  status: number;
  bytes_in: number;
  bytes_out: number;
  duration_ms: number;
  notes: string;
}

interface StoredUsage {
  month: string;
  project_id: string | null;
  project_environment_id: string | null;
  name: string;
  label: string;
  description: string | null;
  value: number;
}

function usageIn(file: string): StoredUsage[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT month, project_id, project_environment_id, name, label, description, value FROM usage
         ORDER BY month, project_id, project_environment_id, name`
      )
      .all()
      .map((row) => ({ ...row })) as unknown as StoredUsage[];
  } finally {
    database.close();
  }
}

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

async function upstreamAnswering(t: TestContext, body: string, status = 200): Promise<string> {
  const server = createServer(async (request, response) => {
    request.resume();
    await once(request, 'end');
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end(body);
  });
  return `http://127.0.0.1:${await listening(t, server)}`;
}

function recordsFileIn(): string {
  return join(mkdtempSync(join(tmpdir(), 'sdk2-records-')), 'data', 'service-records.db');
}

async function recordingService(
  t: TestContext,
  routes: Route[],
  options: { connected?: boolean; recordsFile?: string; counters?: ServiceDefinition['counters'] } = {}
) {
  const recordsFile = options.recordsFile ?? recordsFileIn();
  const records = createFileServiceRecords({ file: recordsFile });
  const defined = definedWith(routes, options.counters === undefined ? {} : { counters: options.counters });
  const { server, service } = createServiceHttpServer(defined, {
    gatewayKey,
    stateFile: join(mkdtempSync(join(tmpdir(), 'sdk2-state-')), 'service-state.db'),
    records,
    configurations: staticConfigurations({
      manifest: definedWith([]).manifest,
      serviceConfiguration,
      ...(options.connected === false ? {} : { projectConfiguration }),
    }),
  });
  const port = await listening(t, server);
  return {
    port,
    recordsFile,
    service,
    usage(): StoredUsage[] {
      records.flush();
      return usageIn(recordsFile);
    },
    rows(): StoredCall[] {
      records.flush();
      const database = new DatabaseSync(recordsFile, { readOnly: true });
      try {
        return database.prepare('SELECT * FROM calls ORDER BY id').all() as unknown as StoredCall[];
      } finally {
        database.close();
      }
    },
  };
}

const callIdentity = () => mintCallerIdentity({ ...testServiceCaller, kind: 'call' }, gatewayKey);

function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { 'x-opsiforce-caller': callIdentity(), ...options.headers },
      },
      async (incoming) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      }
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

test('a proxied request leaves one row with who called, what was asked and how it went', async (t) => {
  const upstreamUrl = await upstreamAnswering(t, 'twelve bytes', 201);
  const service = await recordingService(t, [
    route('POST /api/v3/repos/:owner/:repo/issues', {
      summary: 'Open an issue',
      allowedBy: [],
      to: upstream({ name: 'rest', api: 'REST', url: upstreamUrl, mount: '/api/v3' }),
      check: (_request, ctx) => {
        ctx.note({ repository: `${ctx.params.owner}/${ctx.params.repo}` });
        return ctx.allow();
      },
    }),
  ]);

  const answer = await send(service.port, {
    method: 'POST',
    path: '/api/v3/repos/acme/web/issues?token=query-secret&per_page=5',
    headers: { authorization: 'Bearer header-secret', 'content-type': 'application/json' },
    body: '{"title":"Body secret"}',
  });

  assert.equal(answer.status, 201);
  const [row, ...others] = service.rows();
  assert.equal(others.length, 0);
  assert.ok(row);
  assert.match(row.request_id, /^[0-9a-f-]{36}$/);
  assert.match(row.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(
    {
      callerKind: row.caller_kind,
      projectId: row.project_id,
      projectEnvironmentId: row.project_environment_id,
      environment: row.environment,
      method: row.method,
      path: row.path,
      route: row.route,
      outcome: row.outcome,
      reason: row.reason,
      status: row.status,
      bytesIn: row.bytes_in,
      bytesOut: row.bytes_out,
      notes: JSON.parse(row.notes),
    },
    {
      callerKind: 'call',
      projectId: testServiceCaller.projectId,
      projectEnvironmentId: testServiceCaller.projectEnvironmentId,
      environment: testServiceCaller.environment,
      method: 'POST',
      path: '/api/v3/repos/acme/web/issues',
      route: 'Open an issue',
      outcome: 'proxied',
      reason: null,
      status: 201,
      bytesIn: 23,
      bytesOut: 12,
      notes: { repository: 'acme/web' },
    }
  );
  assert.ok(row.duration_ms >= 0);
  const stored = readFileSync(service.recordsFile).toString('latin1');
  for (const secret of ['query-secret', 'header-secret', 'Body secret']) assert.ok(!stored.includes(secret));
});

test('each outcome is recorded with its reason, and a request without a Caller identity leaves none', async (t) => {
  const service = await recordingService(t, [
    route('GET /handled', {
      summary: 'A handled answer',
      allowedBy: [],
      check: allowAll,
      handle: () => new Response('hello'),
    }),
    route('GET /refused', {
      summary: 'Pull requests',
      allowedBy: [],
      check: (_request, ctx) => ctx.notAllowed({ setting: 'repositories', message: 'acme/api is not listed' }),
      handle: () => new Response('never'),
    }),
    route('GET /broken', {
      summary: 'Broken',
      allowedBy: [],
      check: allowAll,
      handle: () => {
        throw new Error('boom');
      },
    }),
    route('* /workflows', { summary: 'Workflows are not available through this service', allowedBy: [] }),
  ]);

  await send(service.port, { path: '/handled' });
  await send(service.port, { path: '/refused' });
  await send(service.port, { path: '/broken' });
  await send(service.port, { path: '/workflows' });
  await send(service.port, { path: '/nothing-here' });
  await send(service.port, { path: '/handled', headers: { 'x-opsiforce-caller': '' } });
  await send(service.port, { path: '/.well-known/opsiforce' });

  const rows = service.rows().map((row) => ({
    path: row.path,
    route: row.route,
    outcome: row.outcome,
    status: row.status,
    reason: row.reason,
  }));
  assert.deepEqual(rows, [
    { path: '/handled', route: 'A handled answer', outcome: 'handled', status: 200, reason: null },
    {
      path: '/refused',
      route: 'Pull requests',
      outcome: 'not allowed',
      status: 403,
      reason:
        'acme/api is not listed. Setting "Repositories": https://opsiforce.test/projects/project_test?configure=service&field=repositories',
    },
    { path: '/broken', route: 'Broken', outcome: 'failed', status: 502, reason: 'handle threw: boom' },
    {
      path: '/workflows',
      route: 'Workflows are not available through this service',
      outcome: 'not supported',
      status: 404,
      reason: 'Workflows are not available through this service.',
    },
    {
      path: '/nothing-here',
      route: null,
      outcome: 'not supported',
      status: 404,
      reason: 'GET /nothing-here is not supported by this service.',
    },
    { path: '/.well-known/opsiforce', route: '/.well-known/opsiforce', outcome: 'handled', status: 200, reason: null },
  ]);
});

test('a failure answers the caller in plain words while its Call log reason keeps the detail', async (t) => {
  const generic =
    "GitHub couldn't do this. Try again; if it keeps failing, an Organization admin can check this service's Calls.";
  const service = await recordingService(t, [
    route('GET /throws', {
      summary: 'Throws',
      allowedBy: [],
      check: allowAll,
      handle: () => {
        throw new Error('boom at listRepositories');
      },
    }),
    route('GET /no-verdict', {
      summary: 'No verdict',
      allowedBy: [],
      check: () => undefined as never,
      handle: () => new Response('never'),
    }),
    route('GET /gone/**', {
      summary: 'Unreachable',
      allowedBy: [],
      check: allowAll,
      to: upstream({ name: 'gone', api: 'Gone API', url: 'http://127.0.0.1:9', mount: '/gone' }),
    }),
  ]);

  const answers = [
    await send(service.port, { path: '/throws' }),
    await send(service.port, { path: '/no-verdict' }),
    await send(service.port, { path: '/gone/x' }),
  ];

  assert.deepEqual(
    answers.map((answer) => (JSON.parse(answer.body) as { message: string }).message),
    [
      generic,
      generic,
      "GitHub couldn't reach its upstream system. Try again; if it keeps failing, an Organization admin can check this service's Calls.",
    ]
  );
  const reasons = service.rows().map((row) => row.reason ?? '');
  assert.equal(reasons[0], 'handle threw: boom at listRepositories');
  assert.match(reasons[1] ?? '', /^check returned no verdict/);
  assert.match(reasons[2] ?? '', /^upstream failed: /);
});

test('a refusal before any route is recorded as not allowed with the refusal message', async (t) => {
  const service = await recordingService(
    t,
    [
      route('GET /handled', {
        summary: 'A handled answer',
        allowedBy: [],
        check: allowAll,
        handle: () => new Response('hello'),
      }),
    ],
    { connected: false }
  );

  const answer = await send(service.port, { path: '/handled' });

  assert.equal(answer.headers['opsiforce-outcome'], 'not connected');
  const [row] = service.rows();
  assert.equal(row?.outcome, 'not allowed');
  assert.equal(row?.status, 403);
  assert.match(row?.reason ?? '', /^This Project is not connected to GitHub\./);
});

test('a streamed answer is recorded when it ends, with every byte counted', async (t) => {
  const chunk = 'x'.repeat(64 * 1024);
  const service = await recordingService(t, [
    route('GET /stream', {
      summary: 'A long answer',
      allowedBy: [],
      check: allowAll,
      handle: () => new Response(chunk.repeat(4)),
    }),
  ]);

  const answer = await send(service.port, { path: '/stream' });

  assert.equal(answer.body.length, chunk.length * 4);
  assert.equal(service.rows()[0]?.bytes_out, chunk.length * 4);
});

test('rows older than 30 days are pruned as new ones are written', () => {
  const file = recordsFileIn();
  const day = 24 * 60 * 60 * 1000;
  let now = Date.parse('2026-09-01T10:00:00.000Z');
  const records = createFileServiceRecords({ file, now: () => now });
  const row = (requestId: string) => ({
    requestId,
    time: new Date(now).toISOString(),
    callerKind: 'call' as const,
    projectId: 'p',
    projectEnvironmentId: 'pe',
    environment: 'development',
    method: 'GET',
    path: '/x',
    route: null,
    outcome: 'handled' as const,
    reason: null,
    status: 200,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
    notes: {},
  });

  records.call(row('old'));
  records.flush();
  now += 29 * day;
  records.call(row('recent'));
  records.flush();
  now += 2 * day;
  records.call(row('new'));
  records.flush();
  records.close();

  const database = new DatabaseSync(file, { readOnly: true });
  const ids = database.prepare('SELECT request_id FROM calls ORDER BY id').all() as { request_id: string }[];
  database.close();
  assert.deepEqual(
    ids.map((entry) => entry.request_id),
    ['recent', 'new']
  );
});

test('a burst of rows and counts is written at once when 10,000 are waiting, and none is dropped', () => {
  const file = recordsFileIn();
  const records = createFileServiceRecords({ file, flushAfterMs: 60 * 60 * 1000 });
  const rowCount = (): number => {
    if (!existsSync(file)) return 0;
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      return (database.prepare('SELECT count(*) AS n FROM calls').get() as { n: number }).n;
    } finally {
      database.close();
    }
  };

  for (let index = 0; index < 10_001; index += 1) {
    records.call({
      requestId: `request-${index}`,
      time: '2026-10-17T09:30:00.000Z',
      callerKind: 'platform',
      projectId: null,
      projectEnvironmentId: null,
      environment: null,
      method: 'POST',
      path: '/.well-known/opsiforce/webhook',
      route: 'webhook',
      outcome: 'handled',
      reason: null,
      status: 200,
      bytesIn: 0,
      bytesOut: 0,
      durationMs: 1,
      notes: {},
    });
    records.count({
      name: 'messages',
      label: 'Messages',
      description: null,
      n: 1,
      projectId: null,
      projectEnvironmentId: `pe-${index}`,
      environment: null,
    });
  }

  assert.equal(rowCount(), 10_000);
  records.close();
  assert.equal(rowCount(), 10_001);
  assert.equal(usageIn(file).length, 10_001);
});

test('the records file uses a rollback journal: never WAL, the journal truncated after each commit', async (t) => {
  const service = await recordingService(t, [
    route('GET /handled', {
      summary: 'A handled answer',
      allowedBy: [],
      check: allowAll,
      handle: () => new Response('hello'),
    }),
  ]);

  await send(service.port, { path: '/handled' });
  service.rows();

  const header = readFileSync(service.recordsFile).subarray(18, 20);
  assert.deepEqual([...header], [1, 1]);
  assert.equal(existsSync(`${service.recordsFile}-wal`), false);
  assert.equal(existsSync(`${service.recordsFile}-shm`), false);
  assert.equal(statSync(`${service.recordsFile}-journal`).size, 0);
});

test('call requests count as requests, not allowed and failed in this month, platform calls do not', async (t) => {
  const service = await recordingService(t, [
    route('GET /handled', {
      summary: 'A handled answer',
      allowedBy: [],
      check: allowAll,
      handle: () => new Response('hello'),
    }),
    route('GET /refused', {
      summary: 'Refused',
      allowedBy: [],
      check: (_request, ctx) => ctx.notAllowed({ message: 'no' }),
      handle: () => new Response('never'),
    }),
    route('GET /broken', {
      summary: 'Broken',
      allowedBy: [],
      check: allowAll,
      handle: () => {
        throw new Error('boom');
      },
    }),
  ]);

  await send(service.port, { path: '/handled' });
  await send(service.port, { path: '/handled' });
  await send(service.port, { path: '/refused' });
  await send(service.port, { path: '/broken' });
  await send(service.port, { path: '/nothing-here' });
  await send(service.port, { path: '/handled', headers: { 'x-opsiforce-caller': '' } });
  await send(service.port, {
    path: '/.well-known/opsiforce',
    headers: { 'x-opsiforce-caller': mintCallerIdentity({ ...testServiceCaller, kind: 'platform' }, gatewayKey) },
  });

  const month = new Date().toISOString().slice(0, 7);
  const counted = (name: string, label: string, value: number) => ({
    month,
    project_id: testServiceCaller.projectId,
    project_environment_id: testServiceCaller.projectEnvironmentId,
    name,
    label,
    value,
  });
  assert.deepEqual(
    service.usage().map(({ description: _description, ...row }) => row),
    [counted('failed', 'Failed', 1), counted('not_allowed', 'Not allowed', 1), counted('requests', 'Requests', 5)]
  );
});

test('declared counters keep their label and description per Project environment, or on the Service row', async (t) => {
  const service = await recordingService(
    t,
    [
      route('POST /pulls', {
        summary: 'Open a pull request',
        allowedBy: [],
        check: allowAll,
        handle: (_request, ctx) => {
          ctx.count('pull_requests_opened');
          ctx.count('pull_requests_opened', 2);
          return new Response('opened');
        },
      }),
    ],
    {
      counters: {
        pull_requests_opened: { label: 'Pull requests opened', description: 'Through this service' },
        pushes_rejected: { label: 'Pushes rejected' },
      },
    }
  );

  await send(service.port, { method: 'POST', path: '/pulls' });
  service.service.count('pushes_rejected', 4);
  service.service.count('pushes_rejected', 1, { projectEnvironment: 'pe_other' });

  const month = new Date().toISOString().slice(0, 7);
  const declared = service.usage().filter((row) => !['requests', 'not_allowed', 'failed'].includes(row.name));
  assert.deepEqual(declared, [
    {
      month,
      project_id: null,
      project_environment_id: null,
      name: 'pushes_rejected',
      label: 'Pushes rejected',
      description: null,
      value: 4,
    },
    {
      month,
      project_id: null,
      project_environment_id: 'pe_other',
      name: 'pushes_rejected',
      label: 'Pushes rejected',
      description: null,
      value: 1,
    },
    {
      month,
      project_id: testServiceCaller.projectId,
      project_environment_id: testServiceCaller.projectEnvironmentId,
      name: 'pull_requests_opened',
      label: 'Pull requests opened',
      description: 'Through this service',
      value: 3,
    },
  ]);
});

test('counts fall into the UTC month they happen in and are never pruned', () => {
  const file = recordsFileIn();
  let now = Date.parse('2026-09-30T23:59:59.000Z');
  const records = createFileServiceRecords({ file, now: () => now });
  const count = (n: number) =>
    records.count({
      name: 'cards_created',
      label: 'Cards created',
      description: null,
      n,
      projectId: 'p',
      projectEnvironmentId: 'pe',
      environment: 'development',
    });

  count(2);
  records.flush();
  count(3);
  now = Date.parse('2026-10-01T00:00:00.000Z');
  count(5);
  records.flush();
  now = Date.parse('2027-02-01T00:00:00.000Z');
  records.call({
    requestId: 'later',
    time: new Date(now).toISOString(),
    callerKind: 'call',
    projectId: 'p',
    projectEnvironmentId: 'pe',
    environment: 'development',
    method: 'GET',
    path: '/x',
    route: null,
    outcome: 'handled',
    reason: null,
    status: 200,
    bytesIn: 0,
    bytesOut: 0,
    durationMs: 1,
    notes: {},
  });
  records.close();

  assert.deepEqual(
    usageIn(file).map((row) => [row.month, row.name, row.value]),
    [
      ['2026-09', 'cards_created', 5],
      ['2026-10', 'cards_created', 5],
      ['2027-02', 'requests', 1],
    ]
  );
});
