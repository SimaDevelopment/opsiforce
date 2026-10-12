import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceError } from '@opsiforce/external-service-sdk';
import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceCalls } from '../../db/schema';
import { DefaultLaneHolds } from '../../src/external-services/gate/default-lane-holds';
import { startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import { disableProject } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { callRow } from './support/gate';
import { environmentDatabase } from './support/inbound';
import {
  BOARDS_MANIFEST,
  consumerIn,
  freePort,
  publishCustomService,
  READY_BOARDS,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';

const PUBLIC_URL = 'https://opsiforce.example.com';
const SIGNATURE_HEADER = 'x-boards-signature';

describe("a Custom External Service's own webhook URL", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let pod: FakeServicePod;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-inbound-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_000,
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
    await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    pod = await startFakeServicePod({
      manifest: BOARDS_MANIFEST,
      gatewayKey: service.key,
      port: podPort,
    });
    pod.scriptInbound(async (request, ctx) => {
      if (request.headers[SIGNATURE_HEADER] !== ctx.serviceConfiguration.apiSecret) {
        throw new ServiceError({ status: 401, code: 'bad-signature' });
      }
      await ctx.state.set('last-webhook', ctx.webhookUrl);
      const card = request.body as { boardId: string; name: string; id: string };
      return {
        events: [
          {
            type: 'card.created',
            key: card.id,
            occurredAt: '2026-10-08T09:30:00.000Z',
            data: { boardId: card.boardId, name: card.name },
          },
        ],
      };
    });
  });

  afterEach(async () => {
    await pod.close();
  });

  function sendCard(card: { id: string; boardId: string; name: string }, signature = READY_BOARDS.apiSecret) {
    return app.inject({
      method: 'POST',
      url: `/api/external-services/webhooks/${service.id}`,
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signature },
      payload: JSON.stringify(card),
    });
  }

  it('holds a webhook that arrives while the Default environment is switching, then stores it', async () => {
    const roadmap = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, roadmap, 'boards', { boardIds: ['b1'], receive: { 'card.created': true } });
    const holds = app.get(DefaultLaneHolds);
    expect(await holds.hold(service.id, 1_000)).toBe(true);
    setTimeout(() => holds.release(service.id), 200);

    const res = await sendCard({ id: 'card-during-switch', boardId: 'b1', name: 'Ship it' });

    expect(res.statusCode, res.body).toBe(200);
    expect((await environmentDatabase(storageRoot, roadmap.projectEnvironmentId)).events).toEqual([
      expect.objectContaining({ key: 'card-during-switch' }),
    ]);
  });

  it('routes a webhook once more, and only once, when a switch moved the Default while it waited', async () => {
    const holds = app.get(DefaultLaneHolds);
    expect(await holds.hold(service.id, 1_000)).toBe(true);
    setTimeout(() => holds.release(service.id, 'env-the-webhook-never-reaches'), 50);

    const res = await sendCard({ id: 'card-after-switch', boardId: 'b1', name: 'Ship it' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service-moved' });
    expect(res.headers['retry-after']).toBe('2');
    const calls = await db
      .select()
      .from(externalServiceCalls)
      .where(eq(externalServiceCalls.externalServiceId, service.id));
    expect(calls.filter((call) => call.kind === 'inbound')).toEqual([
      expect.objectContaining({ kind: 'inbound', decision: 'refused', status: 503, code: 'service-moved' }),
      expect.objectContaining({ kind: 'inbound', decision: 'refused', status: 503, code: 'service-moved' }),
    ]);
    expect(pod.requests).toEqual([]);
  });

  it("stores the service's Events in the receiving consumer environments of its Organization", async () => {
    const roadmap = await consumerIn(app, admin.tenant);
    const operations = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, roadmap, 'boards', { boardIds: ['b1'], receive: { 'card.created': true } });
    await saveConsumerConfiguration(app, operations, 'boards', {
      boardIds: ['b2'],
      receive: { 'card.created': true },
    });

    const res = await sendCard({ id: 'card-1', boardId: 'b1', name: 'Ship it' });

    expect(res.statusCode, res.body).toBe(200);
    expect((await environmentDatabase(storageRoot, roadmap.projectEnvironmentId)).events).toEqual([
      expect.objectContaining({
        service: 'boards',
        type: 'card.created',
        key: 'card-1',
        data: { boardId: 'b1', name: 'Ship it' },
      }),
    ]);
    expect((await environmentDatabase(storageRoot, operations.projectEnvironmentId)).events).toEqual([]);
    expect(pod.requests.map((request) => [request.path, request.gatewayKey])).toEqual([
      ['/_service/inbound', service.key],
    ]);
  });

  it("logs the inbound Call under the service's Organization and keeps ctx.state in the service pod", async () => {
    const res = await sendCard({ id: 'card-2', boardId: 'b1', name: 'Nobody listens' });

    expect(res.statusCode, res.body).toBe(200);
    const [call] = await db
      .select()
      .from(externalServiceCalls)
      .where(eq(externalServiceCalls.externalServiceId, service.id))
      .orderBy(desc(externalServiceCalls.createdAt))
      .limit(1);
    expect(call).toMatchObject({
      kind: 'inbound',
      tenantId: admin.tenant.tenantId,
      serviceEnvironmentId: service.environmentId,
      decision: 'allowed',
      code: 'unmatched',
    });
    expect(await pod.state.list()).toEqual([
      { key: 'last-webhook', value: `${PUBLIC_URL}/api/external-services/webhooks/${service.id}` },
    ]);
  });

  it('passes a rejected signature through as 401 with a refused Call', async () => {
    const res = await sendCard({ id: 'card-3', boardId: 'b1', name: 'Forged' }, 'wrong');

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'bad-signature' });
    expect(await callRow(res.json().callId)).toMatchObject({
      kind: 'inbound',
      externalServiceId: service.id,
      tenantId: admin.tenant.tenantId,
      serviceEnvironmentId: service.environmentId,
      decision: 'refused',
    });
  });

  it('answers 404 for an id that is no published service', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/external-services/webhooks/${crypto.randomUUID()}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown-service' });
  });

  it("answers a provider's HEAD check of both webhook URLs with 200, without reaching its pod", async () => {
    const production = await app.inject({ method: 'HEAD', url: `/api/external-services/webhooks/${service.id}` });
    const development = await app.inject({
      method: 'HEAD',
      url: `/api/external-services/webhooks/${service.id}/development`,
    });

    expect(production.statusCode).toBe(200);
    expect(development.statusCode).toBe(200);
    expect(pod.requests).toEqual([]);
  });

  it('answers a HEAD check of a webhook URL that names no service with 404', async () => {
    const res = await app.inject({ method: 'HEAD', url: `/api/external-services/webhooks/${crypto.randomUUID()}` });

    expect(res.statusCode).toBe(404);
  });

  it('answers 503 while the service is disabled, without reaching its pod', async () => {
    await disableProject(service.builderChatId);

    const res = await sendCard({ id: 'card-4', boardId: 'b1', name: 'Paused' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service-disabled' });
    expect(pod.requests).toEqual([]);
  });
});
