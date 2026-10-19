import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createFileServiceRecords,
  recordsFileInWorkspace,
  type CountEntry,
} from '@opsiforce/external-service-sdk/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceUsage } from '../../db/schema';
import { Perms } from '../../src/permission/permission.constants';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder, TENANT_SERVICES } from './support/custom-services';
import { builtInServiceId, tenantAdmin, type PersonFixture } from './support/fixtures';
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
import { allowAll, route } from '@opsiforce/external-service-sdk';

const PUBLIC_URL = 'https://opsiforce.example.com';
const READY_SDK2_BOARDS = { apiToken: 'boards-api-token-1', region: 'eu' };

interface UsageCounter {
  name: string;
  label: string;
  description: string | null;
  builtIn: boolean;
}

interface UsageEnvironment {
  projectEnvironmentId: string | null;
  environmentName: string | null;
  values: Record<string, number>;
}

interface UsageProject {
  projectId: string | null;
  title: string | null;
  deleted: boolean;
  values: Record<string, number>;
  environments: UsageEnvironment[];
}

interface ServiceUsage {
  months: string[];
  month: string | null;
  counters: UsageCounter[];
  projects: UsageProject[];
  service: Record<string, number> | null;
  totals: Record<string, number>;
}

describe('the Usage an SDK 2 service keeps, read by the backend', () => {
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
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-usage-'));
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
      counters: { cards_created: { label: 'Cards created', description: 'Cards opened on a board' } },
      routes: () => [
        route('POST /cards', {
          summary: 'Create a card',
          allowedBy: [],
          check: allowAll,
          handle: (_request, ctx) => {
            ctx.count('cards_created');
            return Response.json({ created: true });
          },
        }),
        route('GET /boards/b9', {
          summary: 'Board b9',
          allowedBy: [],
          check: (_request, ctx) => ctx.notAllowed({ message: 'Board b9 is not listed' }),
          handle: () => Response.json({}),
        }),
        route('GET /boards', {
          summary: 'List boards',
          allowedBy: [],
          check: allowAll,
          handle: () => Response.json([]),
        }),
      ],
    });
    pods.push(pod);
    return pod;
  }

  async function callAs(consumer: GateCallerFixture, path: string, init: RequestInit = {}): Promise<void> {
    const answer = await callAsGate(
      await resolved(app, { credential: `Bearer ${consumer.key}`, slug: 'boards' }),
      path,
      init
    );
    await answer.arrayBuffer();
  }

  function read(url: string, person: { headers: Record<string, string> } = admin) {
    return app.inject({ method: 'GET', url, headers: person.headers });
  }

  async function usage(query = '', person: { headers: Record<string, string> } = admin): Promise<ServiceUsage> {
    const res = await read(`${TENANT_SERVICES}/${service.id}/usage${query}`, person);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ServiceUsage>();
  }

  function stagedCounts(file: string, at: string, entries: Partial<CountEntry>[]): void {
    const records = createFileServiceRecords({ file, now: () => Date.parse(at) });
    for (const entry of entries) {
      records.count({
        name: 'cards_created',
        label: 'Cards created',
        description: null,
        n: 1,
        projectId: first.projectId,
        projectEnvironmentId: first.projectEnvironmentId,
        environment: 'development',
        ...entry,
      });
    }
    records.close();
  }

  it('shows this month’s built-in totals and counters by Project and environment, with a totals row', async () => {
    const pod = await startPod();
    await callAs(first, '/cards', { method: 'POST' });
    await callAs(first, '/cards', { method: 'POST' });
    await callAs(first, '/boards/b9');
    await callAs(second, '/boards');
    pod.service.count('cards_created', 5);
    pod.flushRecords();

    const answer = await usage();

    const month = new Date().toISOString().slice(0, 7);
    expect(answer.months).toEqual([month]);
    expect(answer.month).toBe(month);
    expect(answer.counters).toEqual([
      { name: 'requests', label: 'Requests', description: expect.any(String), builtIn: true },
      { name: 'not_allowed', label: 'Not allowed', description: expect.any(String), builtIn: true },
      { name: 'failed', label: 'Failed', description: expect.any(String), builtIn: true },
      { name: 'cards_created', label: 'Cards created', description: 'Cards opened on a board', builtIn: false },
    ]);
    const byTitle = Object.fromEntries(answer.projects.map((project) => [project.title, project]));
    expect(byTitle[first.projectTitle]).toEqual({
      projectId: first.projectId,
      title: first.projectTitle,
      deleted: false,
      values: { requests: 3, not_allowed: 1, cards_created: 2 },
      environments: [
        {
          projectEnvironmentId: first.projectEnvironmentId,
          environmentName: 'Development',
          values: { requests: 3, not_allowed: 1, cards_created: 2 },
        },
      ],
    });
    expect(byTitle[second.projectTitle]?.values).toEqual({ requests: 1 });
    expect(answer.service).toEqual({ cards_created: 5 });
    expect(answer.totals).toEqual({ requests: 4, not_allowed: 1, cards_created: 7 });
  });

  it('offers the months with data, newest first, and hides counters with no count in the chosen month', async () => {
    const file = recordsFileOf(service.directory);
    stagedCounts(file, '2026-08-14T10:00:00.000Z', [{ name: 'boards_archived', label: 'Boards archived' }]);
    stagedCounts(file, '2026-09-02T10:00:00.000Z', [{ n: 4 }]);

    const latest = await usage();
    expect(latest.months).toEqual(['2026-09', '2026-08']);
    expect(latest.month).toBe('2026-09');
    expect(latest.counters.map((counter) => counter.name)).toEqual([
      'requests',
      'not_allowed',
      'failed',
      'cards_created',
    ]);

    const august = await usage('?month=2026-08');
    expect(august.counters.map((counter) => counter.name)).toEqual([
      'requests',
      'not_allowed',
      'failed',
      'boards_archived',
    ]);
    expect(august.totals).toEqual({ boards_archived: 1 });
    expect((await read(`${TENANT_SERVICES}/${service.id}/usage?month=2026-13`)).statusCode).toBe(400);
  });

  it('labels a Project the backend no longer knows "Deleted project", and finds the Project of a ProjectEnvironment-only count', async () => {
    const gone = crypto.randomUUID();
    stagedCounts(recordsFileOf(service.directory), new Date().toISOString(), [
      { projectId: gone, projectEnvironmentId: gone, n: 2 },
      { projectId: null, projectEnvironmentId: second.projectEnvironmentId, n: 3 },
    ]);

    const { projects } = await usage();

    expect(projects).toEqual([
      expect.objectContaining({
        projectId: second.projectId,
        title: second.projectTitle,
        values: { cards_created: 3 },
      }),
      expect.objectContaining({ projectId: gone, title: null, deleted: true, values: { cards_created: 2 } }),
    ]);
  });

  it('reads the Development copy’s own file with copy=development', async () => {
    const development = await runningDevelopment(app, storageRoot, service.builderChatId, SDK2_BOARDS_MANIFEST);
    stagedCounts(recordsFileOf(development.directory), new Date().toISOString(), [{ n: 9 }]);
    stagedCounts(recordsFileOf(service.directory), new Date().toISOString(), [{ n: 1 }]);

    expect((await usage('?copy=development')).totals).toEqual({ cards_created: 9 });
    expect((await usage()).totals).toEqual({ cards_created: 1 });
  });

  it('answers no months when the service has written nothing yet', async () => {
    expect(await usage()).toEqual({
      months: [],
      month: null,
      counters: expect.any(Array),
      projects: [],
      service: null,
      totals: {},
    });
  });

  it('says the records cannot be read, with the copy’s pod state, when the file is not a database', async () => {
    const file = recordsFileOf(service.directory);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'not a database at all, just text that fills the header and more'.repeat(20));

    const res = await read(`${TENANT_SERVICES}/${service.id}/usage`);

    expect(res.statusCode, res.body).toBe(502);
    expect(res.json()).toMatchObject({ code: 'records-unreadable', podState: expect.any(String) });
  });

  it('is read with the same permission as the Calls tab', async () => {
    const member = await addMember(app, admin.tenant, [Perms.usePublicApi]);

    expect((await read(`${TENANT_SERVICES}/${service.id}/usage`, member)).statusCode).toBe(403);
  });

  it('keeps a built-in’s Usage readable on its page, from the platform’s own table', async () => {
    const builtInId = await builtInServiceId(FIXTURE_SERVICE);
    await db.insert(externalServiceUsage).values(
      [
        ['requests', 'Requests', 6],
        ['not_allowed', 'Not allowed', 2],
        ['failed', 'Failed', 1],
        ['events', 'Events', 3],
      ].map(([name, label, value]) => ({
        id: crypto.randomUUID(),
        tenantId: admin.tenant.tenantId,
        projectId: first.projectId,
        projectEnvironmentId: first.projectEnvironmentId,
        service: FIXTURE_SERVICE,
        month: '2026-07-01',
        name: name as string,
        label: label as string,
        value: value as number,
      }))
    );

    const res = await read(`${TENANT_SERVICES}/${builtInId}/usage`);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      months: ['2026-07'],
      month: '2026-07',
      counters: [
        { name: 'requests', builtIn: true },
        { name: 'not_allowed', builtIn: true },
        { name: 'failed', builtIn: true },
        { name: 'events', label: 'Events', builtIn: true },
      ],
      projects: [{ projectId: first.projectId, values: { requests: 6, not_allowed: 2, failed: 1, events: 3 } }],
      totals: { requests: 6, not_allowed: 2, failed: 1, events: 3 },
    });
  });

  it('Admin → Usage is gone: no Organization-wide usage or calls endpoint', async () => {
    expect((await read('/api/external-services/admin/usage')).statusCode).toBe(404);
    expect((await read('/api/external-services/admin/calls')).statusCode).toBe(404);
  });
});
