import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceCalls } from '../../db/schema';
import { startFakeApp, type FakeApp } from './support/fake-app';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { usageRowsOf } from './support/call-log';
import {
  appActivity,
  deliveryCalls,
  doorbellQueue,
  podComesUp,
  podStarts,
  reportAppServing,
  ringDoorbells,
  suspend,
} from './support/doorbell';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import { configurePlatformService, type GateCallerFixture } from './support/gate';
import {
  environmentDatabase,
  INBOX_SERVICE,
  INBOX_SIGNING_KEY,
  inboundBuiltInsDir,
  providerEvent,
  receivingEnvironment,
  sendWebhook,
} from './support/inbound';

const DOORBELL_PATH = `/api/external-services/${INBOX_SERVICE}`;

describe('the doorbell that wakes the App for stored Events', () => {
  let storageRoot: string;
  let fakeApp: FakeApp;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  const bootHarness = () =>
    createExternalServicesTestApp({
      builtInsDir: inboundBuiltInsDir,
      env: { STORAGE_MOUNT_PATH: storageRoot },
      config: { appPort: fakeApp.port },
    });

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'doorbell-'));
    fakeApp = await startFakeApp();
    harness = await bootHarness();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await fakeApp.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fakeApp.received.length = 0;
    fakeApp.answer(200);
    await forgetPlatformServiceConfiguration(INBOX_SERVICE);
    await configurePlatformService(app, INBOX_SERVICE, { signingKey: INBOX_SIGNING_KEY });
  });

  async function runningReceiver(): Promise<{ receiver: GateCallerFixture; address: string }> {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });
    await podComesUp(app, receiver.projectEnvironmentId);
    return { receiver, address };
  }

  async function sendMessages(address: string, keys: string[]): Promise<void> {
    for (const key of keys) {
      const res = await sendWebhook(app, {
        events: [providerEvent({ type: 'message.received', key, data: { address, text: `text of ${key}` } })],
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  }

  it('rings once for a burst of Events and carries every new id', async () => {
    const { receiver, address } = await runningReceiver();

    await sendMessages(address, ['burst-1', 'burst-2', 'burst-3']);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received).toEqual([
      {
        path: DOORBELL_PATH,
        authorization: undefined,
        body: { service: INBOX_SERVICE, eventIds: events.map((event) => event.id) },
      },
    ]);
    expect(events).toHaveLength(3);
    expect(appActivity(app, receiver.projectEnvironmentId)).toBeGreaterThan(0);
    expect(await deliveryCalls(receiver.projectEnvironmentId)).toEqual([
      expect.objectContaining({
        kind: 'delivery',
        slug: INBOX_SERVICE,
        tenantId: receiver.tenant.tenantId,
        projectId: receiver.projectId,
        projectTitle: receiver.projectTitle,
        decision: 'allowed',
        status: 200,
        code: null,
      }),
    ]);
    expect(await usageRowsOf(receiver.projectEnvironmentId)).toEqual([
      expect.objectContaining({ calls: 0, refused: 0, failed: 0, events: 3 }),
    ]);
  });

  it('stamps delivered Events and never sends their ids again', async () => {
    const { receiver, address } = await runningReceiver();
    await sendMessages(address, ['stamp-1', 'stamp-2']);
    await ringDoorbells(app);

    await sendMessages(address, ['stamp-3']);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([
      [events[0]?.id, events[1]?.id],
      [events[2]?.id],
    ]);
  });

  it('queues one coalesced ring per environment and service before answering the provider', async () => {
    const { receiver, address } = await runningReceiver();

    await sendMessages(address, ['queued-1', 'queued-2']);

    const queued = doorbellQueue(app)
      .jobs()
      .filter((job) => job.data.projectEnvironmentId === receiver.projectEnvironmentId);
    expect(queued).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ service: INBOX_SERVICE, retry: 0 }) }),
    ]);
    await ringDoorbells(app);
  });

  it('wakes a sleeping App before ringing and counts it as app activity', async () => {
    const { receiver, address } = await runningReceiver();
    await suspend(app, receiver.projectEnvironmentId);
    const startsBefore = podStarts(app, receiver.projectEnvironmentId);
    const activityBefore = appActivity(app, receiver.projectEnvironmentId);
    await sendMessages(address, ['wake-1']);

    const ringing = ringDoorbells(app);
    await podComesUp(app, receiver.projectEnvironmentId, startsBefore);
    expect(fakeApp.received).toEqual([]);
    expect((await reportAppServing(app, receiver)).statusCode).toBe(201);
    await ringing;

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([events.map((event) => event.id)]);
    expect(appActivity(app, receiver.projectEnvironmentId)).toBeGreaterThan(activityBefore);
  });

  function queuedRingOf(projectEnvironmentId: string) {
    return doorbellQueue(app)
      .jobs()
      .find((job) => job.data.projectEnvironmentId === projectEnvironmentId);
  }

  it('rings again after 30 s, 2 min, 10 min, 1 h and 6 h while the App fails, then stops', async () => {
    const { receiver, address } = await runningReceiver();
    fakeApp.answer(503);
    await sendMessages(address, ['retry-1']);
    const ring = queuedRingOf(receiver.projectEnvironmentId);

    await ringDoorbells(app, Number.POSITIVE_INFINITY);

    expect(fakeApp.received).toHaveLength(6);
    expect(doorbellQueue(app).delaysOf(ring?.id ?? '')).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
    expect(queuedRingOf(receiver.projectEnvironmentId)).toBeUndefined();
    const calls = await deliveryCalls(receiver.projectEnvironmentId);
    expect(calls.map((call) => [call.status, call.code])).toEqual(Array.from({ length: 6 }, () => [503, 'app-failed']));
    expect(calls[0]?.detail).toBe('The App answered 503. Ringing again in 30 s.');
    expect(calls[5]?.detail).toBe('The App answered 503. Gave up after 6 rings.');
    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(events.map((event) => event.appDeliveredAt)).toEqual([null]);

    fakeApp.answer(200);
    fakeApp.received.length = 0;
    await sendMessages(address, ['retry-2']);
    await ringDoorbells(app);
    const after = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([after.events.map((event) => event.id)]);
  });

  it('stops ringing when the App refuses the ring with a 4xx other than 404', async () => {
    const { receiver, address } = await runningReceiver();
    fakeApp.answer(400);
    await sendMessages(address, ['refused-1']);

    await ringDoorbells(app, Number.POSITIVE_INFINITY);

    expect(fakeApp.received).toHaveLength(1);
    expect(queuedRingOf(receiver.projectEnvironmentId)).toBeUndefined();
    const calls = await deliveryCalls(receiver.projectEnvironmentId);
    expect(calls.map((call) => [call.status, call.code])).toEqual([[400, 'app-refused']]);
  });

  it('rings again for an Event stored while the previous ring was finishing', async () => {
    const { receiver, address } = await runningReceiver();
    await sendMessages(address, ['early-1']);
    doorbellQueue(app).beforeNextCompletion(() => sendMessages(address, ['late-1']));

    await ringDoorbells(app, Number.POSITIVE_INFINITY);

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([[events[0]?.id], [events[1]?.id]]);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
  });

  it('delivers on the next ring once a failing App recovers', async () => {
    const { receiver, address } = await runningReceiver();
    fakeApp.answerNext(500);
    await sendMessages(address, ['recover-1']);

    await ringDoorbells(app, Number.POSITIVE_INFINITY);

    const calls = await deliveryCalls(receiver.projectEnvironmentId);
    expect(calls.map((call) => [call.status, call.code])).toEqual([
      [500, 'app-failed'],
      [200, null],
    ]);
    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
  });

  it('App start promotes a delayed ring, rings at once and restarts the retry ladder', async () => {
    const { receiver, address } = await runningReceiver();
    fakeApp.answer(503);
    await sendMessages(address, ['promote-1']);
    const ring = queuedRingOf(receiver.projectEnvironmentId);
    await ringDoorbells(app, Date.now() + 60_000);
    expect(doorbellQueue(app).delaysOf(ring?.id ?? '')).toEqual([30_000, 120_000]);

    expect((await reportAppServing(app, receiver)).statusCode).toBe(201);
    await ringDoorbells(app);
    expect(doorbellQueue(app).delaysOf(ring?.id ?? '')).toEqual([30_000, 120_000, 30_000]);

    fakeApp.answer(200);
    expect((await reportAppServing(app, receiver)).statusCode).toBe(201);
    await ringDoorbells(app);

    const calls = await deliveryCalls(receiver.projectEnvironmentId);
    expect(calls.map((call) => [call.status, call.code])).toEqual([
      [503, 'app-failed'],
      [503, 'app-failed'],
      [503, 'app-failed'],
      [200, null],
    ]);
    expect(calls[2]?.detail).toBe('The App answered 503. Ringing again in 30 s.');
    expect(queuedRingOf(receiver.projectEnvironmentId)).toBeUndefined();
    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
  });

  it.each([
    ['gave up', 503],
    ['stopped', 400],
  ])('App start rings a service whose last ring %s while Events still wait', async (_, status) => {
    const { receiver, address } = await runningReceiver();
    fakeApp.answer(status);
    await sendMessages(address, [`after-${status}-1`]);
    await ringDoorbells(app, Number.POSITIVE_INFINITY);
    expect(queuedRingOf(receiver.projectEnvironmentId)).toBeUndefined();

    fakeApp.answer(200);
    fakeApp.received.length = 0;
    expect((await reportAppServing(app, receiver)).statusCode).toBe(201);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([events.map((event) => event.id)]);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
  });

  it('App start with nothing undelivered writes no Call and wakes nothing', async () => {
    const { receiver, address } = await runningReceiver();
    await sendMessages(address, ['idle-1']);
    await ringDoorbells(app);
    fakeApp.received.length = 0;
    const callsBefore = await deliveryCalls(receiver.projectEnvironmentId);
    const activityBefore = appActivity(app, receiver.projectEnvironmentId);
    const startsBefore = podStarts(app, receiver.projectEnvironmentId);

    expect((await reportAppServing(app, receiver)).statusCode).toBe(201);
    expect(queuedRingOf(receiver.projectEnvironmentId)).toBeDefined();
    await ringDoorbells(app);

    expect(fakeApp.received).toEqual([]);
    expect(await deliveryCalls(receiver.projectEnvironmentId)).toEqual(callsBefore);
    expect(appActivity(app, receiver.projectEnvironmentId)).toBe(activityBefore);
    expect(podStarts(app, receiver.projectEnvironmentId)).toBe(startsBefore);
  });

  it.each([404, 501])('stops waking an App that answers %i until the App starts again', async (status) => {
    const { receiver, address } = await runningReceiver();
    fakeApp.answer(status);
    await sendMessages(address, [`unwired-${status}-1`]);
    await ringDoorbells(app);
    expect(await deliveryCalls(receiver.projectEnvironmentId)).toEqual([
      expect.objectContaining({ decision: 'refused', status, code: 'not-wired' }),
    ]);

    fakeApp.answer(200);
    fakeApp.received.length = 0;
    const activityBefore = appActivity(app, receiver.projectEnvironmentId);
    await sendMessages(address, [`unwired-${status}-2`]);
    await ringDoorbells(app);
    expect(fakeApp.received).toEqual([]);
    expect(appActivity(app, receiver.projectEnvironmentId)).toBe(activityBefore);

    expect((await reportAppServing(app, receiver)).statusCode).toBe(201);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([events.map((event) => event.id)]);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
  });

  it('still delivers when the backend restarts between queueing and ringing', async () => {
    const { receiver, address } = await runningReceiver();
    await sendMessages(address, ['restart-1', 'restart-2']);
    const persisted = JSON.parse(JSON.stringify(doorbellQueue(app).jobs())) as ReturnType<
      ReturnType<typeof doorbellQueue>['jobs']
    >;

    await harness.close();
    harness = await bootHarness();
    app = harness.app;
    await podComesUp(app, receiver.projectEnvironmentId);
    doorbellQueue(app).restore(persisted);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([events.map((event) => event.id)]);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
  });

  it('answers 503 when the doorbell cannot be queued, and the provider resend rings it', async () => {
    const { receiver, address } = await runningReceiver();
    const payload = {
      events: [providerEvent({ type: 'message.received', key: 'unqueued-1', data: { address, text: 'Hello' } })],
    };
    doorbellQueue(app).failNextAdd(new Error('Redis is unreachable'));

    const refused = await sendWebhook(app, payload);
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['content-type']).toContain('application/problem+json');
    expect(refused.json()).toMatchObject({ status: 503, code: 'doorbell-unavailable' });
    const [logged] = await db
      .select({ status: externalServiceCalls.status, code: externalServiceCalls.code })
      .from(externalServiceCalls)
      .where(eq(externalServiceCalls.id, refused.json<{ callId: string }>().callId));
    expect(logged).toEqual({ status: 503, code: 'doorbell-unavailable' });

    expect((await sendWebhook(app, payload)).statusCode).toBe(200);
    await ringDoorbells(app);
    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.eventIds)).toEqual([events.map((event) => event.id)]);
  });
});
