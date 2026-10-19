import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createFileServiceRecords,
  mintCallerIdentity,
  recordsFileInWorkspace,
  type CallRow,
} from '@opsiforce/external-service-sdk/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Perms } from '../../src/permission/permission.constants';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { callAsGate, gatewayUrlOf, resolved } from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import {
  consumerIn,
  freePort,
  publishCustomService,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';
import { SDK2_BOARDS_MANIFEST, startSdk2ServicePod, type Sdk2ServicePod } from './support/sdk2-service-pod';
import { runningDevelopment } from './support/test-lane';

const PUBLIC_URL = 'https://opsiforce.example.com';
const READY_SDK2_BOARDS = { apiToken: 'boards-api-token-1', region: 'eu' };

interface ListedCall {
  requestId: string;
  time: string;
  callerKind: 'call' | 'platform';
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environment: string | null;
  environmentName: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: string;
  reason: string | null;
  status: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  notes: Record<string, unknown>;
}

interface CallLogPage {
  calls: ListedCall[];
  projects: { projectId: string; title: string | null }[];
  retentionDays: number;
  newer: string | null;
  older: string | null;
}

describe('the Call log an SDK 2 service writes, read by the backend', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let first: GateCallerFixture;
  let second: GateCallerFixture;
  let pods: Sdk2ServicePod[];

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-call-log-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_500,
    });
    app = harness.app;
    backendUrl = await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pods = [];
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: SDK2_BOARDS_MANIFEST });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_SDK2_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    first = await consumerIn(app, admin.tenant);
    second = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, first, 'boards', { boardIds: ['b1'] });
    await saveConsumerConfiguration(app, second, 'boards', { boardIds: ['b2'] });
  });

  afterEach(async () => {
    for (const pod of pods) await pod.close();
  });

  function recordsFileOf(directory: string): string {
    return join(storageRoot, directory, recordsFileInWorkspace);
  }

  async function startPod(): Promise<Sdk2ServicePod> {
    const pod = await startSdk2ServicePod({
      gatewayKey: service.key,
      gatewayUrl: gatewayUrlOf(backendUrl),
      port: podPort,
      recordsFile: recordsFileOf(service.directory),
    });
    pods.push(pod);
    return pod;
  }

  async function callAs(consumer: GateCallerFixture, path: string, init: RequestInit = {}): Promise<Response> {
    const answer = await callAsGate(
      await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }),
      path,
      init
    );
    await answer.arrayBuffer();
    return answer;
  }

  function read(url: string, person: { headers: Record<string, string> } = admin) {
    return app.inject({ method: 'GET', url, headers: person.headers });
  }

  async function page(url: string, person: { headers: Record<string, string> } = admin): Promise<CallLogPage> {
    const res = await read(url, person);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<CallLogPage>();
  }

  const serviceCallLog = (query = '') => `${TENANT_SERVICES}/${service.id}/call-log${query}`;
  const environmentCallLog = (consumer: GateCallerFixture, query = '') =>
    `/api/external-services/projects/${consumer.projectId}/environments/${consumer.projectEnvironmentId}/services/${service.id}/call-log${query}`;

  function stagedRows(file: string, rows: Partial<CallRow>[], at: number): void {
    const records = createFileServiceRecords({ file, now: () => at });
    for (const [index, row] of rows.entries()) {
      records.call({
        requestId: crypto.randomUUID(),
        time: new Date(at - index * 1000).toISOString(),
        callerKind: 'call',
        projectId: first.projectId,
        projectEnvironmentId: first.projectEnvironmentId,
        environment: 'development',
        method: 'GET',
        path: `/cards/${index}`,
        route: 'Answers every request with what it saw',
        outcome: 'handled',
        reason: null,
        status: 200,
        bytesIn: 0,
        bytesOut: 10,
        durationMs: 3,
        notes: {},
        ...row,
      });
    }
    records.close();
  }

  it('lists every request the Default copy received, newest first, with its caller named', async () => {
    const pod = await startPod();
    await callAs(first, '/cards?board=b1&token=query-secret', { method: 'POST', body: 'seven b' });
    await callAs(second, '/boards');
    pod.flushRecords();

    const { calls, projects, newer, older, retentionDays } = await page(serviceCallLog());

    expect(calls.map(({ path, projectTitle }) => [path, projectTitle])).toEqual([
      ['/boards', second.projectTitle],
      ['/cards', first.projectTitle],
    ]);
    expect(calls[1]).toEqual({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      time: expect.stringMatching(/Z$/),
      callerKind: 'call',
      projectId: first.projectId,
      projectTitle: first.projectTitle,
      projectEnvironmentId: first.projectEnvironmentId,
      environment: expect.any(String),
      environmentName: 'Development',
      method: 'POST',
      path: '/cards',
      route: 'Answers every request with what it saw',
      outcome: 'handled',
      reason: null,
      status: 200,
      bytesIn: 7,
      bytesOut: expect.any(Number),
      durationMs: expect.any(Number),
      notes: {},
    });
    expect(projects.map((project) => project.title).toSorted()).toEqual(
      [first.projectTitle, second.projectTitle].toSorted()
    );
    expect([newer, older, retentionDays]).toEqual([null, null, 30]);
  });

  it('filters by outcome and Project and time range, listing platform calls only when they did not succeed', async () => {
    const now = Date.now();
    stagedRows(
      recordsFileOf(service.directory),
      [
        { path: '/recent' },
        { path: '/refused', outcome: 'not allowed', status: 403, reason: 'Board b9 is not listed.' },
        { path: '/other', projectId: second.projectId, projectEnvironmentId: second.projectEnvironmentId },
        { path: '/.well-known/opsiforce', callerKind: 'platform', projectId: null, projectEnvironmentId: null },
        {
          path: '/.well-known/opsiforce/options/listBoards',
          callerKind: 'platform',
          outcome: 'failed',
          status: 502,
          reason: 'options.listBoards threw: upstream answered 403',
        },
        { path: '/proxied', outcome: 'proxied' },
      ],
      now
    );
    stagedRows(recordsFileOf(service.directory), [{ path: '/two-days-ago' }], now - 2 * 24 * 60 * 60 * 1000);

    const paths = async (query: string) => (await page(serviceCallLog(query))).calls.map((call) => call.path);

    expect(await paths('?outcome=not%20allowed')).toEqual(['/refused']);
    expect(await paths('?outcome=allowed')).toEqual(['/recent', '/other', '/proxied', '/two-days-ago']);
    expect(await paths('?outcome=failed')).toEqual(['/.well-known/opsiforce/options/listBoards']);
    expect(await paths(`?project=${second.projectId}`)).toEqual(['/other']);
    expect(await paths('?since=24h')).toEqual([
      '/recent',
      '/refused',
      '/other',
      '/.well-known/opsiforce/options/listBoards',
      '/proxied',
    ]);
    expect(await paths('?since=7d&project=' + first.projectId)).toEqual([
      '/recent',
      '/refused',
      '/.well-known/opsiforce/options/listBoards',
      '/proxied',
      '/two-days-ago',
    ]);
    expect((await read(serviceCallLog('?outcome=refused'))).statusCode).toBe(400);
    expect((await read(serviceCallLog('?outcome=proxied'))).statusCode).toBe(400);
    expect((await read(serviceCallLog('?since=2h'))).statusCode).toBe(400);
  });

  it("names no other Organization's Project or environment a service wrote into its records", async () => {
    const foreign = await consumerIn(app, (await tenantAdmin(app)).tenant);
    stagedRows(
      recordsFileOf(service.directory),
      [{ path: '/foreign', projectId: foreign.projectId, projectEnvironmentId: foreign.projectEnvironmentId }],
      Date.now()
    );

    const { calls, projects } = await page(serviceCallLog());

    expect(calls).toEqual([expect.objectContaining({ path: '/foreign', projectTitle: null, environmentName: null })]);
    expect(projects.map((project) => project.title)).not.toContain(foreign.projectTitle);
  });

  it('pages older and newer with cursors', async () => {
    stagedRows(
      recordsFileOf(service.directory),
      Array.from({ length: 30 }, () => ({})),
      Date.now()
    );

    const newest = await page(serviceCallLog());
    expect(newest.calls).toHaveLength(25);
    expect(newest.calls[0]?.path).toBe('/cards/0');
    expect(newest.newer).toBeNull();

    const oldest = await page(serviceCallLog(`?older=${newest.older}`));
    expect(oldest.calls.map((call) => call.path)).toEqual([
      '/cards/25',
      '/cards/26',
      '/cards/27',
      '/cards/28',
      '/cards/29',
    ]);
    expect(oldest.older).toBeNull();

    const back = await page(serviceCallLog(`?newer=${oldest.newer}`));
    expect(back.calls.map((call) => call.path)).toEqual(newest.calls.map((call) => call.path));
    expect(back.newer).toBeNull();
  });

  it("shows a Project's people only their own ProjectEnvironment's calls", async () => {
    const pod = await startPod();
    await callAs(first, '/mine');
    await callAs(second, '/theirs');
    pod.flushRecords();
    const member = await addMember(app, admin.tenant, [Perms.usePublicApi]);

    const { calls } = await page(environmentCallLog(first), member);

    expect(calls.map((call) => call.path)).toEqual(['/mine']);
  });

  it('reads the Development copy’s own file with copy=development', async () => {
    const development = await runningDevelopment(app, storageRoot, service.builderChatId, SDK2_BOARDS_MANIFEST);
    stagedRows(recordsFileOf(development.directory), [{ path: '/from-the-test-project' }], Date.now());
    stagedRows(recordsFileOf(service.directory), [{ path: '/from-a-consumer' }], Date.now());

    expect((await page(serviceCallLog('?copy=development'))).calls.map((call) => call.path)).toEqual([
      '/from-the-test-project',
    ]);
    expect((await page(serviceCallLog())).calls.map((call) => call.path)).toEqual(['/from-a-consumer']);
  });

  it('answers an empty page when the service has written no records yet', async () => {
    expect((await page(serviceCallLog())).calls).toEqual([]);
  });

  it('a platform call that succeeded is recorded but not listed', async () => {
    const pod = await startPod();
    const identity = mintCallerIdentity({ kind: 'platform', tenantId: admin.tenant.tenantId }, service.key);
    await (await fetch(`${pod.url}/.well-known/opsiforce`, { headers: { 'x-opsiforce-caller': identity } })).text();
    pod.flushRecords();

    const { calls } = await page(serviceCallLog());

    expect(calls).toEqual([]);
  });

  describe('reading a file the service is writing, never writing to it', () => {
    async function leaveHotJournal(file: string): Promise<void> {
      stagedRows(file, [{ path: '/committed' }], Date.now());
      const snapshot = await mkdtemp(join(tmpdir(), 'records-snapshot-'));
      const writer = new DatabaseSync(file);
      writer.exec('PRAGMA journal_mode = TRUNCATE');
      writer.exec('PRAGMA cache_size = 2');
      writer.exec('BEGIN IMMEDIATE');
      writer.exec(
        `WITH RECURSIVE spill(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM spill WHERE value < 400)
         INSERT INTO calls (request_id, time, caller_kind, method, path, outcome, status, bytes_in, bytes_out, duration_ms, notes)
         SELECT 'spill-' || value, '2026-01-01T00:00:00.000Z', 'call', 'GET', printf('%.500c', 'x'), 'handled', 200, 0, 0, 0, '{}' FROM spill`
      );
      await copyFile(file, join(snapshot, 'records.db'));
      await copyFile(`${file}-journal`, join(snapshot, 'records.db-journal'));
      writer.exec('ROLLBACK');
      writer.close();
      await copyFile(join(snapshot, 'records.db'), file);
      await copyFile(join(snapshot, 'records.db-journal'), `${file}-journal`);
      await rm(snapshot, { recursive: true, force: true });
    }

    it('answers "records busy, reload" while a commit is in flight, and the rows once it lands', async () => {
      const file = recordsFileOf(service.directory);
      await leaveHotJournal(file);

      const busy = await read(serviceCallLog());
      expect(busy.statusCode, busy.body).toBe(503);
      expect(busy.json()).toMatchObject({ code: 'records-busy', message: 'The records are busy; reload.' });
      expect((await stat(`${file}-journal`)).size).toBeGreaterThan(0);

      await rm(`${file}-journal`);
      expect((await page(serviceCallLog())).calls.map((call) => call.path)).toEqual(['/committed']);
    });

    it('says the records cannot be read, with the copy’s pod state, when the file is not a database', async () => {
      const file = recordsFileOf(service.directory);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'not a database at all, just text that fills the header and more'.repeat(20));

      const res = await read(serviceCallLog());

      expect(res.statusCode, res.body).toBe(502);
      expect(res.json()).toMatchObject({ code: 'records-unreadable', podState: expect.any(String) });
    });
  });
});
