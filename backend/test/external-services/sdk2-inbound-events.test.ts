import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DeliveredEvent, WebhookHandler } from '@opsiforce/external-service-sdk';
import { gatewayEvents, verifyCallerIdentity } from '@opsiforce/external-service-sdk/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Doorbell } from '../../src/external-services/doorbell/doorbell';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder } from './support/custom-services';
import { doorbellQueue } from './support/doorbell';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { gatewayUrlOf, resolvedWebhook, resolveWebhook, webhookAsGate } from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import { projectServiceUrl } from './support/generating';
import { environmentDatabase, fileOnDisk } from './support/inbound';
import {
  consumerIn,
  freePort,
  publishCustomService,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';
import { SDK2_BOARDS_MANIFEST, startSdk2ServicePod, type Sdk2ServicePod } from './support/sdk2-service-pod';
import { createTestProject, runningDevelopment, saveTestProjectConfiguration } from './support/test-lane';

const PUBLIC_URL = 'https://opsiforce.example.com';
const READY_SDK2_BOARDS = { apiToken: 'boards-api-token-1', region: 'eu' };

const INBOUND_BOARDS_MANIFEST = {
  ...SDK2_BOARDS_MANIFEST,
  inbound: true,
  events: {
    'card.created': { title: 'Card created', description: 'Someone created a card on a board.' },
  },
};

interface WebhookOrder {
  to: string[];
  key: string;
  type?: string;
}

function cardCreated(key: string, type = 'card.created'): DeliveredEvent {
  return { type, key, occurredAt: '2026-10-17T09:30:00.000Z', data: { card: key } };
}

const deliveringWhatItIsTold: WebhookHandler = async (request, ctx) => {
  const order = (await request.json()) as WebhookOrder;
  const results = await ctx.service.deliver(cardCreated(order.key, order.type), { to: order.to });
  ctx.note({ results });
};

describe('Inbound Events an SDK 2 service delivers itself', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let backendUrl: string;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let first: GateCallerFixture;
  let second: GateCallerFixture;
  let unconnected: GateCallerFixture;
  let pods: Sdk2ServicePod[];

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'sdk2-inbound-'));
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
    service = await publishCustomService(app, admin, storageRoot, {
      slug: 'boards',
      manifest: INBOUND_BOARDS_MANIFEST,
    });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_SDK2_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    first = await consumerIn(app, admin.tenant);
    second = await consumerIn(app, admin.tenant);
    unconnected = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, first, 'boards', { boardIds: ['b1'] });
    await saveConsumerConfiguration(app, second, 'boards', { boardIds: ['b2'] });
  });

  afterEach(async () => {
    for (const pod of pods) await pod.close();
  });

  async function startPod(key = service.key, webhook: WebhookHandler = deliveringWhatItIsTold) {
    const pod = await startSdk2ServicePod({
      gatewayKey: key,
      gatewayUrl: gatewayUrlOf(backendUrl),
      port: podPort,
      manifest: INBOUND_BOARDS_MANIFEST,
      webhook,
    });
    pods.push(pod);
    return pod;
  }

  async function postWebhook(order: WebhookOrder, development = false): Promise<Response> {
    const resolved = await resolvedWebhook(app, { service: service.id, development });
    return webhookAsGate(resolved, '', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(order),
    });
  }

  async function storedKeys(consumer: { projectEnvironmentId: string }): Promise<string[]> {
    return (await environmentDatabase(storageRoot, consumer.projectEnvironmentId)).events.map((event) => event.key);
  }

  function rungFor(projectEnvironmentId: string): boolean {
    return doorbellQueue(app)
      .jobs()
      .some(
        (job) => job.data.projectEnvironmentId === projectEnvironmentId && job.data.externalServiceId === service.id
      );
  }

  it('resolves the Webhook address to the Default copy with a platform identity naming no ProjectEnvironment', async () => {
    await startPod();

    const resolved = await resolvedWebhook(app, { service: service.id });

    expect(resolved).toMatchObject({
      servedBy: 'pod',
      serviceId: service.id,
      slug: 'boards',
      tenantId: service.tenantId,
    });
    expect(resolved.upstream).toBe(`http://127.0.0.1:${podPort}`);
    const identity = verifyCallerIdentity(resolved.callerIdentity, service.key);
    expect(identity).toMatchObject({ kind: 'platform', tenantId: service.tenantId });
    expect(identity?.projectEnvironmentId).toBeUndefined();
  });

  it('refuses an unknown service and a service without inbound with 404', async () => {
    const plain = await publishCustomService(app, admin, storageRoot, {
      slug: 'plain-boards',
      manifest: SDK2_BOARDS_MANIFEST,
    });

    const unknown = await resolveWebhook(app, { service: crypto.randomUUID() });
    const noInbound = await resolveWebhook(app, { service: plain.id });

    expect(unknown.statusCode).toBe(404);
    expect(noInbound.statusCode).toBe(404);
    expect(noInbound.json<{ message: string }>().message).toMatch(/does not receive webhooks/);
  });

  it('stores the Event for each connected receiver and queues its doorbell before answering', async () => {
    await startPod();

    const answer = await postWebhook({ to: [first.projectEnvironmentId, second.projectEnvironmentId], key: 'c-1' });

    expect(answer.status).toBe(200);
    expect(rungFor(first.projectEnvironmentId)).toBe(true);
    expect(rungFor(second.projectEnvironmentId)).toBe(true);
    expect(await storedKeys(first)).toEqual(['c-1']);
    expect(await storedKeys(second)).toEqual(['c-1']);
    const [event] = (await environmentDatabase(storageRoot, first.projectEnvironmentId)).events;
    expect(event).toMatchObject({ service: 'boards', type: 'card.created', data: { card: 'c-1' } });
  });

  it('answers each receiver: duplicate for a key already held, not-connected for a Project without a configuration', async () => {
    const pod = await startPod();
    await pod.service.deliver(cardCreated('c-2'), { to: [first.projectEnvironmentId] });

    const results = await pod.service.deliver(cardCreated('c-2'), {
      to: [first.projectEnvironmentId, second.projectEnvironmentId, unconnected.projectEnvironmentId],
    });

    expect(results).toEqual([
      { projectEnvironmentId: first.projectEnvironmentId, result: 'duplicate' },
      { projectEnvironmentId: second.projectEnvironmentId, result: 'stored' },
      { projectEnvironmentId: unconnected.projectEnvironmentId, result: 'not-connected' },
    ]);
    expect(await storedKeys(first)).toEqual(['c-2']);
    expect(await storedKeys(unconnected)).toEqual([]);
  });

  it('a webhook delivering to a Project that is not connected is answered 503 so the provider retries', async () => {
    await startPod();

    const answer = await postWebhook({
      to: [first.projectEnvironmentId, unconnected.projectEnvironmentId],
      key: 'c-3',
    });

    expect(answer.status).toBe(503);
    expect(await storedKeys(first)).toEqual(['c-3']);
  });

  it('caps deliveries at 60 a minute per receiver; others still store', async () => {
    const pod = await startPod();
    for (let index = 0; index < 60; index++) {
      const [result] = await pod.service.deliver(cardCreated(`burst-${index}`), { to: [first.projectEnvironmentId] });
      expect(result?.result).toBe('stored');
    }

    const results = await pod.service.deliver(cardCreated('burst-60'), {
      to: [first.projectEnvironmentId, second.projectEnvironmentId],
    });
    const webhook = await postWebhook({ to: [first.projectEnvironmentId], key: 'burst-61' });

    expect(results).toEqual([
      { projectEnvironmentId: first.projectEnvironmentId, result: 'over-cap' },
      { projectEnvironmentId: second.projectEnvironmentId, result: 'stored' },
    ]);
    expect(webhook.status).toBe(503);
    expect(await storedKeys(first)).toHaveLength(60);
    expect(await storedKeys(second)).toEqual(['burst-60']);
  });

  it('copies each file into every receiving environment', async () => {
    const pod = await startPod();

    await pod.service.deliver(
      {
        ...cardCreated('c-4'),
        files: [{ name: 'note.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hello board') }],
      },
      { to: [first.projectEnvironmentId, second.projectEnvironmentId] }
    );

    for (const consumer of [first, second]) {
      const { eventFiles } = await environmentDatabase(storageRoot, consumer.projectEnvironmentId);
      expect(eventFiles).toMatchObject([{ name: 'note.txt', mimeType: 'text/plain', sizeBytes: 11 }]);
      expect(await fileOnDisk(storageRoot, consumer.projectEnvironmentId, eventFiles[0]?.path ?? '')).toBe(
        'hello board'
      );
    }
  });

  it('refuses an envelope it cannot store with 400 problems, before storing anything', async () => {
    const pod = await startPod();

    await expect(
      pod.service.deliver(cardCreated('c-5', 'card.deleted'), { to: [first.projectEnvironmentId] })
    ).rejects.toThrow(/answered 400: .*card\.deleted.* is not a declared Event type/);
    await expect(
      pod.service.deliver({ ...cardCreated('c-5'), occurredAt: 'yesterday' }, { to: [first.projectEnvironmentId] })
    ).rejects.toThrow(/occurredAt/);
    expect(await storedKeys(first)).toEqual([]);
  });

  it('refuses a delivery sent with a key of no service copy with 401', async () => {
    const events = gatewayEvents({ url: gatewayUrlOf(backendUrl), gatewayKey: 'gw-not-a-real-key' });

    await expect(events.deliver(cardCreated('c-6'), [first.projectEnvironmentId])).rejects.toThrow(/answered 401/);
  });

  it('shows the Project dialog how many Events the App has not taken yet, and when the App is not wired', async () => {
    const pod = await startPod();
    await pod.service.deliver(cardCreated('c-7'), { to: [first.projectEnvironmentId] });
    await pod.service.deliver(cardCreated('c-8'), { to: [first.projectEnvironmentId] });
    const status = () =>
      app.inject({
        method: 'GET',
        url: `${projectServiceUrl(first, service.id)}/event-delivery`,
        headers: admin.headers,
      });

    const waiting = await status();
    await app.get(Doorbell).markUnwired(first.projectEnvironmentId, service.id);
    const unwired = await status();

    expect(waiting.statusCode, waiting.body).toBe(200);
    expect(waiting.json()).toEqual({ notYetTaken: 2, appNotWired: false });
    expect(unwired.json()).toEqual({ notYetTaken: 2, appNotWired: true });
  });

  it('keeps the lanes apart: Development delivers only to its Test Project, the Default copy never does', async () => {
    const development = await runningDevelopment(app, storageRoot, service.builderChatId, INBOUND_BOARDS_MANIFEST);
    const testProject = await createTestProject(app, development.key);
    const saved = await saveTestProjectConfiguration(app, development.key, { boardIds: ['b1'] });
    expect(saved.statusCode, saved.body).toBe(200);

    const developmentPod = await startPod(development.key);
    const fromDevelopment = await developmentPod.service.deliver(cardCreated('lane-1'), {
      to: [testProject.projectEnvironmentId, first.projectEnvironmentId],
    });
    const resolved = await resolvedWebhook(app, { service: service.id, development: true });
    await developmentPod.close();
    pods = [];
    const defaultPod = await startPod();
    const fromDefault = await defaultPod.service.deliver(cardCreated('lane-2'), {
      to: [testProject.projectEnvironmentId, first.projectEnvironmentId],
    });

    expect(fromDevelopment).toEqual([
      { projectEnvironmentId: testProject.projectEnvironmentId, result: 'stored' },
      { projectEnvironmentId: first.projectEnvironmentId, result: 'not-connected' },
    ]);
    expect(fromDefault).toEqual([
      { projectEnvironmentId: testProject.projectEnvironmentId, result: 'not-connected' },
      { projectEnvironmentId: first.projectEnvironmentId, result: 'stored' },
    ]);
    expect(verifyCallerIdentity(resolved.callerIdentity, development.key)).toMatchObject({ kind: 'platform' });
    expect(verifyCallerIdentity(resolved.callerIdentity, service.key)).toBeUndefined();
  });
});
