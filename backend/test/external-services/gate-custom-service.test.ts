import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createFileServiceState } from '@opsiforce/external-service-sdk/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServices } from '../../db/schema';
import { ServiceDefaultEnvironments } from '../../src/external-services/publishing/service-default-environments';
import { AppReadinessService } from '../../src/project/app-readiness.service';
import { ProjectEventsService } from '../../src/project/project-events.service';
import type { TimeoutService } from '../../src/timeout/timeout.service';
import { EnvironmentService } from '../../src/environment/environment.service';
import { PodService } from '../../src/pod/pod.service';
import { environmentStateFile, startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import type { FakePodService } from '../support/infra-fakes';
import { disableProject } from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { askGate, callOperation, callRow, type GateCallerFixture } from './support/gate';
import {
  addServiceEnvironment,
  BOARDS_MANIFEST,
  consumerIn,
  freePort,
  publishCustomService,
  READY_BOARDS,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  serviceEnvironmentRow,
  suspendServicePod,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import { TimeoutListener } from '../../src/timeout/timeout.listener';

const PUBLIC_URL = 'https://opsiforce.example.com';
const START_HOLD_MS = 2_000;

async function addEnvironment(app: NestFastifyApplication, tenantId: string, name: string): Promise<string> {
  const environment = await app.get(EnvironmentService).create(tenantId, { name, slug: name.toLowerCase() });
  return environment.id;
}

describe('the Gate reaching a published Custom External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let consumer: GateCallerFixture;
  let pod: FakeServicePod | null;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-gate-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: START_HOLD_MS,
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pod = null;
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    consumer = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
  });

  afterEach(async () => {
    await pod?.close();
  });

  async function startPod(manifest: unknown = BOARDS_MANIFEST): Promise<FakeServicePod> {
    pod = await startFakeServicePod({
      manifest,
      gatewayKey: service.key,
      stateFile: environmentStateFile(storageRoot, service.directory),
      port: podPort,
    });
    return pod;
  }

  function listCards(caller: GateCallerFixture = consumer, boardId = 'b1', slug = 'boards') {
    return callOperation(app, { key: caller.key, slug, operation: 'list_cards', input: { boardId } });
  }

  it("reaches the default environment's pod with that pod's own key and the call's context", async () => {
    const running = await startPod();

    const res = await listCards();

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ operation: 'list_cards', input: { boardId: 'b1' } });
    expect(running.requests.map((request) => request.gatewayKey)).toEqual([service.key]);
    expect(running.received).toHaveLength(1);
    expect(running.received[0]).toMatchObject({
      operation: 'list_cards',
      caller: {
        tenantId: admin.tenant.tenantId,
        projectId: consumer.projectId,
        environmentId: consumer.projectEnvironmentId,
      },
      webhookUrl: `${PUBLIC_URL}/api/external-services/webhooks/${service.id}`,
      serviceConfiguration: READY_BOARDS,
      projectConfiguration: { boardIds: ['b1'] },
    });
    const [row] = await db.select().from(externalServices).where(eq(externalServices.id, service.id));
    expect(row?.defaultEnvironmentId).toBe(service.environmentId);
  });

  it('logs the call against the service, the caller and the default environment', async () => {
    const running = await startPod();
    running.script('list_cards', () => ({ cards: [] }));

    const res = await listCards();
    expect(res.statusCode, res.body).toBe(200);

    const refused = await listCards(consumer, 'b2');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'out-of-bounds', bound: 'board', value: 'b2' });
    expect(running.received).toHaveLength(1);
    expect(await callRow(refused.json().callId)).toMatchObject({
      externalServiceId: service.id,
      tenantId: admin.tenant.tenantId,
      projectEnvironmentId: consumer.projectEnvironmentId,
      serviceEnvironmentId: service.environmentId,
      decision: 'refused',
      code: 'out-of-bounds',
    });
  });

  it("keeps ctx.state in the SQLite file of its Default environment's data folder", async () => {
    const running = await startPod();
    running.script('list_cards', async (_input, ctx) => {
      await ctx.state.set('webhooks/b1', { id: 'wh_1' });
      return { cards: [] };
    });

    const res = await listCards();

    expect(res.statusCode, res.body).toBe(200);
    expect(await createFileServiceState(environmentStateFile(storageRoot, service.directory)).list()).toEqual([
      { key: 'webhooks/b1', value: { id: 'wh_1' } },
    ]);
  });

  it("passes on a handler's out-of-bounds refusal with its 403", async () => {
    const running = await startPod();
    running.script('list_cards', (_input, ctx) => {
      (ctx as unknown as { bounds: { assert(name: string, value: string): void } }).bounds.assert('board', 'b9');
    });

    const res = await listCards();

    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ status: 403, code: 'out-of-bounds', bound: 'board' });
  });

  it('is unknown to every other Organization', async () => {
    const stranger = await consumerIn(app, (await tenantAdmin(app)).tenant);

    const res = await listCards(stranger);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown-service', service: 'boards' });
  });

  it('is unknown while it is a draft', async () => {
    const draft = await createCustomService(app, admin, 'Drafts', 'drafts');

    const res = await callOperation(app, { key: consumer.key, slug: draft.slug, operation: 'list_cards' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown-service' });
  });

  it("answers service-not-configured until the Organization's Service configuration validates", async () => {
    const other = await publishCustomService(app, admin, storageRoot, { slug: 'boards-two' });
    await saveConsumerConfiguration(app, consumer, 'boards-two', { boardIds: ['b1'] });

    const res = await listCards(consumer, 'b1', other.slug);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service-not-configured' });
  });

  it('answers service-disabled for a disabled service whose files cannot be served either', async () => {
    await writeServiceFiles(storageRoot, service.directory, BOARDS_MANIFEST, {
      sdkVersion: '2.0.0',
      modifiedAt: new Date(Date.now() + 60_000),
    });
    await disableProject(service.builderChatId);

    const res = await listCards();

    expect(res.statusCode, res.body).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service-disabled' });
  });

  it('answers service-disabled while its builder Project is disabled', async () => {
    await startPod();
    await disableProject(service.builderChatId);

    const res = await listCards();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service-disabled' });
    expect(pod?.requests).toEqual([]);
  });

  describe('waking the default environment', () => {
    function pods(): FakePodService {
      return app.get(PodService) as unknown as FakePodService;
    }

    function startupsOf(projectEnvironmentId: string): number {
      const podName = pods().assignedPodName(projectEnvironmentId);
      return pods()
        .callsTo('waitForReady')
        .filter((call) => call.args.podName === podName).length;
    }

    it('wakes a sleeping pod and holds the call until it serves', async () => {
      await suspendServicePod(service.projectEnvironmentId);
      const answer = listCards();

      await waitFor(() => startupsOf(service.projectEnvironmentId) > 0);
      await startPod();
      pods().markPodReady(pods().assignedPodName(service.projectEnvironmentId), '127.0.0.1');
      await waitFor(async () => (await serviceEnvironmentRow(service.projectEnvironmentId))?.status === 'active');
      app.get(AppReadinessService).markServing(service.projectEnvironmentId);
      const res = await answer;

      expect(res.statusCode, res.body).toBe(200);
      expect(pod?.received).toHaveLength(1);
      expect(await serviceEnvironmentRow(service.projectEnvironmentId)).toMatchObject({
        status: 'active',
        podIp: '127.0.0.1',
      });
    });

    it('keeps holding the call when a restarting pod left a stale serving mark behind', async () => {
      await suspendServicePod(service.projectEnvironmentId);
      app.get(AppReadinessService).markServing(service.projectEnvironmentId);
      const answer = listCards();

      await waitFor(() => startupsOf(service.projectEnvironmentId) > 0);
      await startPod();
      pods().markPodReady(pods().assignedPodName(service.projectEnvironmentId), '127.0.0.1');
      await waitFor(async () => (await serviceEnvironmentRow(service.projectEnvironmentId))?.status === 'active');
      app.get(AppReadinessService).markServing(service.projectEnvironmentId);
      const res = await answer;

      expect(res.statusCode, res.body).toBe(200);
      expect(pod?.received).toHaveLength(1);
    });

    it('answers service-starting with Retry-After once the hold runs out', async () => {
      await suspendServicePod(service.projectEnvironmentId);

      const res = await listCards();

      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json()).toMatchObject({ code: 'service-starting', service: 'boards' });
      expect(await callRow(res.json().callId)).toMatchObject({
        decision: 'allowed',
        status: 503,
        code: 'service-starting',
      });
      expect(startupsOf(service.projectEnvironmentId)).toBeGreaterThan(0);
    });
  });

  describe('reading the published files', () => {
    it('picks up a changed manifest by its modification time without waking the pod', async () => {
      await suspendServicePod(service.projectEnvironmentId);
      const before = await askGate(app, { key: consumer.key, path: 'boards' });
      expect(before.statusCode, before.body).toBe(200);
      expect(Object.keys(before.json().operations)).toEqual(['list_cards']);

      await writeServiceFiles(
        storageRoot,
        service.directory,
        {
          ...BOARDS_MANIFEST,
          operations: {
            ...BOARDS_MANIFEST.operations,
            archive_card: {
              kind: 'write',
              description: 'Archive a card.',
              input: { type: 'object', properties: { cardId: { type: 'string' } } },
            },
          },
        },
        { modifiedAt: new Date(Date.now() + 60_000) }
      );
      const after = await askGate(app, { key: consumer.key, path: 'boards' });

      expect(after.statusCode, after.body).toBe(200);
      expect(Object.keys(after.json().operations).toSorted()).toEqual(['archive_card', 'list_cards']);
      expect(after.json().manifestHash).not.toBe(before.json().manifestHash);
      expect(await serviceEnvironmentRow(service.projectEnvironmentId)).toMatchObject({ status: 'suspended' });
    });

    it('accepts any SDK 1.x and refuses another major', async () => {
      await startPod();
      await writeServiceFiles(storageRoot, service.directory, BOARDS_MANIFEST, {
        sdkVersion: '1.7.3',
        modifiedAt: new Date(Date.now() + 120_000),
      });
      expect((await listCards()).statusCode).toBe(200);

      await writeServiceFiles(storageRoot, service.directory, BOARDS_MANIFEST, {
        sdkVersion: '2.0.0',
        modifiedAt: new Date(Date.now() + 180_000),
      });
      const res = await listCards();

      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: 'service-failed', service: 'boards' });
      expect(pod?.received).toHaveLength(1);
    });
  });

  describe('idle sleep', () => {
    function expiringListener(): { handleKeyExpiry(envId: string, type: 'agent' | 'app'): Promise<void> } {
      const expired = { isFullyExpired: async () => true } as unknown as TimeoutService;
      return new TimeoutListener(
        expired,
        app.get(PodService),
        app.get(ProjectEventsService),
        app.get(AppReadinessService),
        { clear: () => undefined } as unknown as ConstructorParameters<typeof TimeoutListener>[4]
      ) as unknown as { handleKeyExpiry(envId: string, type: 'agent' | 'app'): Promise<void> };
    }

    it('never suspends the default environment, and suspends its other environments as usual', async () => {
      const staging = await addServiceEnvironment(
        app,
        service.builderChatId,
        admin.tenant.tenantId,
        await addEnvironment(app, admin.tenant.tenantId, 'Staging')
      );
      const listener = expiringListener();

      await listener.handleKeyExpiry(service.projectEnvironmentId, 'app');
      await listener.handleKeyExpiry(staging.projectEnvironmentId, 'app');

      expect(await serviceEnvironmentRow(service.projectEnvironmentId)).toMatchObject({ status: 'active' });
      expect(await serviceEnvironmentRow(staging.projectEnvironmentId)).toMatchObject({ status: 'suspended' });
    });
  });

  describe('the first Publish', () => {
    it('sets the Default environment once, never to Development', async () => {
      const draft = await createCustomService(app, admin, 'Later', 'later');
      const defaults = app.get(ServiceDefaultEnvironments);

      await defaults.publishedTo(draft.builderChatId, draft.builderChatId);
      const [untouched] = await db.select().from(externalServices).where(eq(externalServices.id, draft.id));
      expect(untouched?.defaultEnvironmentId).toBeNull();

      await defaults.publishedTo(service.builderChatId, service.projectEnvironmentId);
      const [kept] = await db
        .select()
        .from(externalServices)
        .where(and(eq(externalServices.id, service.id), eq(externalServices.tenantId, admin.tenant.tenantId)));
      expect(kept?.defaultEnvironmentId).toBe(service.environmentId);
    });
  });
});
