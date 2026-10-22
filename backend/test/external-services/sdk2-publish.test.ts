import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  computeManifestHash,
  createFileServiceRecords,
  createFileServiceState,
  verifyCallerIdentity,
} from '@opsiforce/external-service-sdk/server';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import {
  externalServiceConfigs,
  externalServiceProjectConfigs,
  externalServices,
  projectEnvironments,
  projectPublishJobs,
} from '../../db/schema';
import { EnvironmentService } from '../../src/environment/environment.service';
import { DefaultLaneHolds } from '../../src/external-services/gate/default-lane-holds';
import { ServiceDefaultEnvironments } from '../../src/external-services/publishing/service-default-environments';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { gatewayUrlOf, resolveCaller } from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import {
  addServiceEnvironment,
  consumerIn,
  freePort,
  publishCustomService,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import {
  environmentStateFile,
  SDK2_BOARDS_MANIFEST,
  startSdk2ServicePod,
  type Sdk2ServicePod,
} from './support/sdk2-service-pod';
import {
  committedWorkspace,
  publishReview,
  publishService,
  switchDefaultEnvironment,
  writeTestReport,
} from './support/service-publishing';
import { runningDevelopment, type BuilderDevelopment } from './support/test-lane';

const PUBLIC_URL = 'https://opsiforce.example.com';

const BOARD_OPTIONS = SDK2_BOARDS_MANIFEST.projectForm[0].options;

const NEXT_MANIFEST = {
  ...SDK2_BOARDS_MANIFEST,
  description: 'The board tool, as Development serves it.',
  serviceForm: [
    SDK2_BOARDS_MANIFEST.serviceForm[0],
    { key: 'region', type: 'text', label: 'Region', default: 'eu' },
    { key: 'pageSize', type: 'number', label: 'Page size', default: 50 },
  ],
  projectForm: [
    { key: 'boards', was: 'boardIds', type: 'multiselect', label: 'Boards', required: true, options: BOARD_OPTIONS },
    {
      key: 'team',
      type: 'select',
      label: 'Team',
      default: 'red',
      options: [
        { value: 'red', label: 'Red' },
        { value: 'blue', label: 'Blue' },
      ],
    },
    { key: 'mergePullRequests', type: 'toggle', label: 'Merge pull requests', default: false },
  ],
  events: { 'card.moved': { title: 'Card moved', description: 'A card moved to another list.' } },
};

type Answer = (request: IncomingMessage, response: ServerResponse) => void;

async function startRawPod(port: number, answer: Answer): Promise<Server> {
  const server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe('publishing an SDK 2 service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let development: BuilderDevelopment;
  let closers: (() => Promise<void>)[];
  let gateControl: Server;
  const evictions: { path: string; token: unknown; body: unknown }[] = [];

  const queuedJobs = () =>
    db.select().from(projectPublishJobs).where(eq(projectPublishJobs.projectId, service.builderChatId));

  async function startDevelopmentPod(): Promise<Sdk2ServicePod> {
    const pod = await startSdk2ServicePod({
      gatewayKey: development.key,
      gatewayUrl: gatewayUrlOf(backendUrl),
      port: podPort,
      manifest: NEXT_MANIFEST,
    });
    closers.push(() => pod.close());
    return pod;
  }

  async function startPodAnswering(answer: Answer): Promise<void> {
    const server = await startRawPod(podPort, answer);
    closers.push(() => closeServer(server));
  }

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-publish-'));
    podPort = await freePort();
    const controlPort = await freePort();
    gateControl = await startRawPod(controlPort, (request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        evictions.push({
          path: request.url ?? '',
          token: request.headers['x-proxy-control-token'],
          body: JSON.parse(body),
        });
        response.writeHead(204).end();
      });
    });
    harness = await createExternalServicesTestApp({
      env: {
        OPSIFORCE_PUBLIC_URL: PUBLIC_URL,
        STORAGE_MOUNT_PATH: storageRoot,
        EXTERNAL_SERVICE_PROXY_CONTROL: `127.0.0.1:${controlPort}`,
      },
      servicePodPort: podPort,
      serviceStartHoldMs: 500,
    });
    app = harness.app;
    backendUrl = await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await closeServer(gateControl);
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    closers = [];
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, {
      slug: `boards-${crypto.randomUUID().slice(0, 6)}`,
      manifest: SDK2_BOARDS_MANIFEST,
    });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, { apiToken: 'live-token' });
    expect(saved.statusCode, saved.body).toBe(200);
    development = await runningDevelopment(app, storageRoot, service.builderChatId, NEXT_MANIFEST);
  });

  afterEach(async () => {
    for (const close of closers) await close();
  });

  describe('the Publish probes', () => {
    it('queue the Publish when Development refuses a caller with no identity and an unconnected caller', async () => {
      await startDevelopmentPod();

      const res = await publishService(app, admin, service.id, { environmentId: service.environmentId });

      expect(res.statusCode, res.body).toBe(202);
      expect(await queuedJobs()).toHaveLength(1);
    });

    it('block a Development that lets a caller with no identity through', async () => {
      await startPodAnswering((_request, response) => response.writeHead(200).end('{}'));

      const res = await publishService(app, admin, service.id, { environmentId: service.environmentId });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:probe-failed',
        detail: expect.stringContaining(
          'answered a request with no Caller identity with 200 with no Opsiforce-Outcome header; it must refuse it with 401 with Opsiforce-Outcome: unidentified'
        ),
      });
      expect(await queuedJobs()).toEqual([]);
    });

    it('block a 401 that does not say unidentified', async () => {
      await startPodAnswering((_request, response) => response.writeHead(401).end());

      const res = await publishService(app, admin, service.id, { environmentId: service.environmentId });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().detail).toContain('with 401 with no Opsiforce-Outcome header');
      expect(await queuedJobs()).toEqual([]);
    });

    it('block a Development that answers an unconnected caller', async () => {
      await startPodAnswering((request, response) => {
        if (request.headers['x-opsiforce-caller'] === undefined) {
          response.writeHead(401, { 'opsiforce-outcome': 'unidentified' }).end();
          return;
        }
        response.writeHead(403, { 'opsiforce-outcome': 'not allowed' }).end();
      });

      const res = await publishService(app, admin, service.id, { environmentId: service.environmentId });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().detail).toContain(
        'answered a call from a ProjectEnvironment with no Project configuration with 403 with Opsiforce-Outcome: not allowed; it must refuse it with 403 with Opsiforce-Outcome: not connected'
      );
      expect(await queuedJobs()).toEqual([]);
    });

    it('block when Development does not answer', async () => {
      const res = await publishService(app, admin, service.id, { environmentId: service.environmentId });

      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        type: 'urn:opsiforce:error:probe-failed',
        detail: expect.stringContaining('Start it in the builder chat and publish again.'),
      });
      expect(await queuedJobs()).toEqual([]);
    });
  });

  describe('the Publish review', () => {
    const PUBLISH_NOTE = '## Merge group\n\nLets `PUT .../merge` through under *Merge pull requests*.\n';
    let workspace: string;
    let defaultCommit: string;

    async function writeApp(file: string, text: string): Promise<void> {
      await mkdir(dirname(join(workspace, 'app', file)), { recursive: true });
      await writeFile(join(workspace, 'app', file), text);
    }

    beforeEach(async () => {
      workspace = join(storageRoot, development.directory);
      await writeApp('SKILL.md', '# Boards\n\nReads cards.\n');
      defaultCommit = await committedWorkspace(workspace);
      await db
        .update(projectEnvironments)
        .set({ deployedCommitSha: defaultCommit })
        .where(eq(projectEnvironments.id, service.projectEnvironmentId));
    });

    it('opens with the test warnings and the Publish note, then the code and skill diffs since the Default commit', async () => {
      await writeApp('PUBLISH.md', PUBLISH_NOTE);
      await writeApp('SKILL.md', '# Boards\n\nReads cards and merges pull requests.\n');
      await writeApp('src/groups/merge.ts', "export const routes = [route('PUT /merge', { check: allowAll })];\n");

      const res = await publishReview(app, admin, service.id, service.environmentId);

      expect(res.statusCode, res.body).toBe(200);
      const review = res.json();
      expect(review.testWarnings).toEqual([expect.objectContaining({ code: 'no-test-report' })]);
      expect(review.builtOnSdk1).toBe(false);
      expect(review.publishNote).toBe(PUBLISH_NOTE);
      expect(review.codeDiff).toMatchObject({ state: 'present', truncated: false });
      expect(review.codeDiff.diff).toContain('+++ b/app/src/groups/merge.ts');
      expect(review.codeDiff.diff).toContain("+export const routes = [route('PUT /merge', { check: allowAll })];");
      expect(review.codeDiff.diff).toContain('+++ b/app/PUBLISH.md');
      expect(review.skillDiff.diff).toContain('-Reads cards.');
      expect(review.skillDiff.diff).toContain('+Reads cards and merges pull requests.');
      expect(review.skillDiff.diff).not.toContain('merge.ts');
      expect(review.check).not.toHaveProperty('operations');
      expect(review.changes).not.toHaveProperty('operations');
    });

    it('warns of a missing Publish note, a test of other files and an upstream never called, without blocking', async () => {
      await writeTestReport(workspace, {
        commit: defaultCommit,
        manifestHash: computeManifestHash(SDK2_BOARDS_MANIFEST),
        lines: [{ expectation: 'refuses another board', result: 'pass', source: 'unit-test', callIds: [] }],
      });
      await writeApp('src/groups/merge.ts', 'export const routes = [];\n');

      const review = (await publishReview(app, admin, service.id, service.environmentId)).json();

      expect(review.publishNote).toBeNull();
      expect(review.testWarnings.map((warning: { code: string }) => warning.code)).toEqual([
        'changed-since-test',
        'upstream-never-called',
      ]);
      await startDevelopmentPod();
      expect((await publishService(app, admin, service.id, { environmentId: service.environmentId })).statusCode).toBe(
        202
      );
    });

    it('shows both form diffs, the Events diff and the defaults a Publish writes into existing configurations', async () => {
      const first = await consumerIn(app, admin.tenant);
      const second = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, first, service.slug, { boardIds: ['b1'] });
      await saveConsumerConfiguration(app, second, service.slug, { boardIds: ['b2'] });

      const review = (await publishReview(app, admin, service.id, service.environmentId)).json();

      expect(review.formChanges).toEqual({
        serviceForm: [
          { key: 'region', label: 'Region', change: 'changed', aspects: ['default'], default: 'eu' },
          { key: 'pageSize', label: 'Page size', change: 'added', aspects: [], default: 50 },
        ],
        projectForm: [
          { key: 'boards', label: 'Boards', change: 'renamed', from: 'boardIds', aspects: [] },
          { key: 'team', label: 'Team', change: 'added', aspects: [], default: 'red' },
          { key: 'mergePullRequests', label: 'Merge pull requests', change: 'added', aspects: [], default: false },
          { key: 'signingSecret', label: 'Signing secret', change: 'removed', aspects: [] },
        ],
      });
      expect(review.changes.events).toEqual([{ type: 'card.moved', change: 'added', aspects: [] }]);
      expect(review.impact).toMatchObject({
        configurations: 2,
        renamed: [{ from: 'boardIds', to: 'boards', configurations: 2 }],
        newDefaults: [
          { key: 'team', label: 'Team', value: 'red', configurations: 2 },
          { key: 'mergePullRequests', label: 'Merge pull requests', value: false, configurations: 2 },
        ],
      });
      expect(review.serviceConfiguration.newDefaults).toEqual([
        { key: 'region', label: 'Region', value: 'eu' },
        { key: 'pageSize', label: 'Page size', value: 50 },
      ]);
    });

    it('names a changed type, option list, limit and list-item field in the form diff', async () => {
      const readOnly = [{ value: 'read', label: 'Read' }];
      await writeServiceFiles(storageRoot, service.directory, {
        ...SDK2_BOARDS_MANIFEST,
        serviceForm: [SDK2_BOARDS_MANIFEST.serviceForm[0], { key: 'region', type: 'text', label: 'Region' }],
        projectForm: [
          {
            key: 'boards',
            type: 'list',
            label: 'Boards',
            item: [
              { key: 'board', type: 'text', label: 'Board', required: true },
              { key: 'access', type: 'select', label: 'Access', default: 'read', options: readOnly },
            ],
          },
        ],
      });
      await writeServiceFiles(storageRoot, development.directory, {
        ...SDK2_BOARDS_MANIFEST,
        serviceForm: [
          SDK2_BOARDS_MANIFEST.serviceForm[0],
          { key: 'region', type: 'select', label: 'Region', options: [{ value: 'eu', label: 'Europe' }] },
        ],
        projectForm: [
          {
            key: 'boards',
            type: 'list',
            label: 'Boards',
            maxItems: 3,
            item: [
              { key: 'board', type: 'select', label: 'Board', required: true, options: BOARD_OPTIONS },
              {
                key: 'access',
                type: 'select',
                label: 'Access',
                default: 'read',
                options: [...readOnly, { value: 'write', label: 'Write' }],
              },
              { key: 'notify', type: 'toggle', label: 'Notify', default: false },
            ],
          },
        ],
      });

      const review = (await publishReview(app, admin, service.id, service.environmentId)).json();

      expect(review.formChanges).toEqual({
        serviceForm: [{ key: 'region', label: 'Region', change: 'changed', aspects: ['type', 'options'] }],
        projectForm: [
          {
            key: 'boards',
            label: 'Boards',
            change: 'changed',
            aspects: ['limits', 'item fields'],
            itemChanges: [
              { key: 'board', label: 'Board', change: 'changed', aspects: ['type', 'options'] },
              { key: 'access', label: 'Access', change: 'changed', aspects: ['options'], default: 'read' },
              { key: 'notify', label: 'Notify', change: 'added', aspects: [], default: false },
            ],
          },
        ],
      });
    });
  });

  describe('defaults written when a Publish lands', () => {
    let kept: GateCallerFixture;
    let plain: GateCallerFixture;

    const storedProjectValues = async (consumer: GateCallerFixture) => {
      const [row] = await db
        .select({ values: externalServiceProjectConfigs.values })
        .from(externalServiceProjectConfigs)
        .where(eq(externalServiceProjectConfigs.projectEnvironmentId, consumer.projectEnvironmentId));
      return row?.values;
    };

    const storedCallersValues = async () => {
      const rows = await db
        .select()
        .from(externalServiceConfigs)
        .where(eq(externalServiceConfigs.externalServiceId, service.id));
      return rows.find((row) => row.environment === null)?.values;
    };

    beforeEach(async () => {
      kept = await consumerIn(app, admin.tenant);
      plain = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, kept, service.slug, { boardIds: ['b1'] });
      await saveConsumerConfiguration(app, plain, service.slug, { boardIds: ['b2'] });
      await db
        .update(externalServiceProjectConfigs)
        .set({ values: { boardIds: ['b1'], team: 'green', signingSecret: 'left-from-v1' } })
        .where(eq(externalServiceProjectConfigs.projectEnvironmentId, kept.projectEnvironmentId));
    });

    it('writes each new field default into every stored configuration, keeping renamed, unfit and removed values', async () => {
      await writeServiceFiles(storageRoot, service.directory, NEXT_MANIFEST);
      await app.get(ServiceDefaultEnvironments).publishedTo(service.builderChatId, service.projectEnvironmentId);

      expect(await storedProjectValues(plain)).toMatchObject({
        boardIds: ['b2'],
        team: 'red',
        mergePullRequests: false,
      });
      expect(await storedProjectValues(plain)).not.toHaveProperty('boards');
      expect(await storedProjectValues(kept)).toEqual({
        boardIds: ['b1'],
        team: 'green',
        signingSecret: 'left-from-v1',
        mergePullRequests: false,
      });
      expect(await storedCallersValues()).toMatchObject({ region: 'eu', pageSize: 50 });
      expect((await storedCallersValues())?.apiToken).toBeDefined();
    });

    it('leaves configurations alone while the new version is only in Development', async () => {
      await publishReview(app, admin, service.id, service.environmentId);

      expect(await storedProjectValues(plain)).not.toHaveProperty('team');
      expect(await storedCallersValues()).not.toHaveProperty('pageSize');
    });
  });

  describe('switching the Default environment', () => {
    let staging: { environmentId: string; projectEnvironmentId: string; directory: string; key: string };
    let consumer: GateCallerFixture;

    const recordsFileOf = (directory: string) => join(storageRoot, directory, 'data', 'service-records.db');

    function stagedCall(file: string, path: string): void {
      const records = createFileServiceRecords({ file });
      records.call({
        requestId: crypto.randomUUID(),
        time: new Date().toISOString(),
        callerKind: 'call',
        projectId: consumer.projectId,
        projectEnvironmentId: consumer.projectEnvironmentId,
        environment: 'production',
        method: 'GET',
        path,
        route: 'Lists cards',
        outcome: 'proxied',
        reason: null,
        status: 200,
        bytesIn: 0,
        bytesOut: 10,
        durationMs: 3,
        notes: {},
      });
      records.close();
    }

    function recordedPaths(file: string): string[] {
      const database = new DatabaseSync(file, { readOnly: true });
      try {
        return database
          .prepare('SELECT path FROM calls ORDER BY id')
          .all()
          .map((row) => String(row.path));
      } finally {
        database.close();
      }
    }

    async function leaveHotJournal(file: string): Promise<void> {
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

    beforeEach(async () => {
      const environment = await app
        .get(EnvironmentService)
        .create(admin.tenant.tenantId, { name: 'Staging', slug: `staging-${crypto.randomUUID().slice(0, 6)}` });
      staging = {
        environmentId: environment.id,
        ...(await addServiceEnvironment(app, service.builderChatId, admin.tenant.tenantId, environment.id)),
      };
      await writeServiceFiles(storageRoot, staging.directory, SDK2_BOARDS_MANIFEST);
      consumer = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, consumer, service.slug, { boardIds: ['b1'] });
      evictions.length = 0;
    });

    it("holds the resolve answer while the lane is held, then answers with the new Default's pod", async () => {
      const holds = app.get(DefaultLaneHolds);
      await holds.hold(service.id, 0);
      let settled = false;
      const resolving = resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: service.slug }).then((res) => {
        settled = true;
        return res;
      });

      await sleep(200);
      expect(settled).toBe(false);
      await db
        .update(externalServices)
        .set({ defaultEnvironmentId: staging.environmentId })
        .where(eq(externalServices.id, service.id));
      holds.release(service.id, staging.environmentId);

      const res = await resolving;
      expect(res.statusCode, res.body).toBe(200);
      expect(verifyCallerIdentity(res.json().callerIdentity, staging.key)).toMatchObject({
        projectEnvironmentId: consumer.projectEnvironmentId,
      });
      expect(verifyCallerIdentity(res.json().callerIdentity, service.key)).toBeUndefined();
    });

    it('answers 504 when the lane stays held past the start hold', async () => {
      const holds = app.get(DefaultLaneHolds);
      await holds.hold(service.id, 0);
      try {
        const res = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: service.slug });

        expect(res.statusCode, res.body).toBe(504);
        expect(res.json().message).toContain('is switching its Default environment');
      } finally {
        holds.release(service.id);
      }
    });

    it("evicts the Gate's cache for the slug and carries the records file with ctx.state", async () => {
      stagedCall(recordsFileOf(service.directory), '/cards/before-the-switch');
      await createFileServiceState(environmentStateFile(storageRoot, service.directory)).set('registration', 'wh-7');

      const res = await switchDefaultEnvironment(app, admin, service.id, { environmentId: staging.environmentId });

      expect(res.statusCode, res.body).toBe(200);
      expect(evictions).toEqual([
        {
          path: '/evict',
          token: app.get(ConfigService).getOrThrow<string>('proxyControlToken'),
          body: { tenantId: admin.tenant.tenantId, slug: service.slug },
        },
      ]);
      expect(recordedPaths(recordsFileOf(staging.directory))).toEqual(['/cards/before-the-switch']);
      expect(
        await createFileServiceState(environmentStateFile(storageRoot, staging.directory)).get('registration')
      ).toBe('wh-7');
    });

    it('waits for a commit in flight in the records file, and never rolls back a journal it cannot wait out', async () => {
      const live = recordsFileOf(service.directory);
      stagedCall(live, '/cards/committed');
      await leaveHotJournal(live);
      const landing = sleep(100).then(() => rm(`${live}-journal`));

      const res = await switchDefaultEnvironment(app, admin, service.id, { environmentId: staging.environmentId });
      await landing;

      expect(res.statusCode, res.body).toBe(200);
      expect(recordedPaths(recordsFileOf(staging.directory))).toEqual(['/cards/committed']);

      await leaveHotJournal(recordsFileOf(staging.directory));
      const back = await switchDefaultEnvironment(app, admin, service.id, { environmentId: service.environmentId });

      expect(back.statusCode, back.body).toBe(200);
      expect((await stat(`${recordsFileOf(staging.directory)}-journal`)).size).toBeGreaterThan(0);
    });
  });
});
