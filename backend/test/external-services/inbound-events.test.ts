import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { usageRowsOf } from './support/call-log';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import { configurePlatformService } from './support/gate';
import {
  environmentDatabase,
  fileOnDisk,
  sendMultipartWebhook,
  INBOX_SERVICE,
  INBOX_SIGNING_KEY,
  inboundBuiltInsDir,
  latestInboundCall,
  providerEvent,
  receivingEnvironment,
  sendWebhook,
} from './support/inbound';

const PROBLEM_JSON = 'application/problem+json';

describe('inbound Events into the environment database', () => {
  let storageRoot: string;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'inbound-events-'));
    harness = await createExternalServicesTestApp({
      builtInsDir: inboundBuiltInsDir,
      env: { STORAGE_MOUNT_PATH: storageRoot },
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(INBOX_SERVICE);
    await configurePlatformService(app, INBOX_SERVICE, { signingKey: INBOX_SIGNING_KEY });
  });

  it('stores a matching Event in the receiving environment and answers 200', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });

    const res = await sendWebhook(app, {
      events: [providerEvent({ type: 'message.received', key: 'm-1', data: { address, text: 'Hello' } })],
    });

    expect(res.statusCode).toBe(200);
    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(events).toEqual([
      expect.objectContaining({
        service: INBOX_SERVICE,
        type: 'message.received',
        key: 'm-1',
        occurredAt: '2026-10-08T09:30:00.000Z',
        data: { address, text: 'Hello' },
        appDeliveredAt: null,
      }),
    ]);
    expect(Date.parse(events[0]?.receivedAt ?? '')).not.toBeNaN();
    const call = await latestInboundCall();
    expect(call).toMatchObject({
      kind: 'inbound',
      decision: 'allowed',
      status: 200,
      tenantId: null,
      operation: 'message.received',
      code: null,
    });
  });

  it('answers 401 and writes a refused Call when the signature does not verify', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });

    const res = await sendWebhook(
      app,
      { events: [providerEvent({ type: 'message.received', key: 'm-1', data: { address, text: 'Hello' } })] },
      { signature: 'ab'.repeat(32) }
    );

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON);
    expect(res.json()).toMatchObject({ status: 401, code: 'bad-signature' });
    expect((await environmentDatabase(storageRoot, receiver.projectEnvironmentId)).events).toEqual([]);
    expect(await latestInboundCall()).toMatchObject({
      id: res.json().callId,
      kind: 'inbound',
      decision: 'refused',
      status: 401,
      code: 'bad-signature',
    });
  });

  it('drops an Event whose data does not fit its type as invalid_event and keeps the rest', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });

    const res = await sendWebhook(app, {
      events: [
        providerEvent({ type: 'message.received', key: 'bad-1', data: { address, text: 42 } }),
        providerEvent({ type: 'card.moved', key: 'bad-2', data: { address } }),
        providerEvent({ type: 'message.received', key: 'good-1', data: { address, text: 'Fits' } }),
      ],
    });

    expect(res.statusCode).toBe(200);
    const { events } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(events.map((event) => event.key)).toEqual(['good-1']);
    const call = await latestInboundCall();
    expect(call).toMatchObject({ decision: 'allowed', status: 200, code: 'invalid_event' });
    expect(call?.detail).toContain('2 Events dropped as invalid_event');
  });

  it('answers 200 and logs unmatched when no environment receives the Event', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const switchedOff = await receivingEnvironment(app, { address, receive: { 'message.received': false } });

    const res = await sendWebhook(app, {
      events: [providerEvent({ type: 'message.received', key: 'm-1', data: { address, text: 'Anyone?' } })],
    });

    expect(res.statusCode).toBe(200);
    expect(await environmentDatabase(storageRoot, switchedOff.projectEnvironmentId)).toMatchObject({ events: [] });
    expect(await latestInboundCall()).toMatchObject({ decision: 'allowed', status: 200, code: 'unmatched' });
  });

  it('delivers an array-bound Event only to environments whose labels include it, or that take all labels', async () => {
    const label = { type: 'label.added', data: { labelId: 'billing' } };
    const picked = await receivingEnvironment(app, {
      labelIds: ['billing', 'urgent'],
      receive: { 'label.added': true },
    });
    const other = await receivingEnvironment(app, { labelIds: ['spam'], receive: { 'label.added': true } });
    const everything = await receivingEnvironment(app, { labelsMode: 'all', receive: { 'label.added': true } });
    const everythingButOff = await receivingEnvironment(app, { labelsMode: 'all', receive: { 'label.added': false } });
    const key = `l-${crypto.randomUUID()}`;

    const res = await sendWebhook(app, { events: [providerEvent({ ...label, key })] });

    expect(res.statusCode).toBe(200);
    const keysIn = async (environment: { projectEnvironmentId: string }) =>
      (await environmentDatabase(storageRoot, environment.projectEnvironmentId)).events
        .filter((event) => event.key === key)
        .map((event) => event.type);
    expect(await keysIn(picked)).toEqual(['label.added']);
    expect(await keysIn(everything)).toEqual(['label.added']);
    expect(await keysIn(other)).toEqual([]);
    expect(await keysIn(everythingButOff)).toEqual([]);
  });

  it('delivers a list-bound Event only where the member belongs to that very room', async () => {
    const annInRed = await receivingEnvironment(app, {
      rooms: [{ room: 'red', memberIds: ['ann'] }],
      receive: { 'member.posted': true },
    });
    const annInBlueOnly = await receivingEnvironment(app, {
      rooms: [
        { room: 'red', memberIds: ['bob'] },
        { room: 'blue', memberIds: ['ann'] },
      ],
      receive: { 'member.posted': true },
    });
    const key = `p-${crypto.randomUUID()}`;

    const res = await sendWebhook(app, {
      events: [providerEvent({ type: 'member.posted', key, data: { room: 'red', memberId: 'ann' } })],
    });

    expect(res.statusCode).toBe(200);
    const received = async (environment: { projectEnvironmentId: string }) =>
      (await environmentDatabase(storageRoot, environment.projectEnvironmentId)).events.some(
        (event) => event.key === key
      );
    expect(await received(annInRed)).toBe(true);
    expect(await received(annInBlueOnly)).toBe(false);
  });

  it('stores a repeated Event once', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });
    const payload = {
      events: [providerEvent({ type: 'message.received', key: 'same', data: { address, text: 'Once' } })],
    };

    expect((await sendWebhook(app, payload)).statusCode).toBe(200);
    expect((await sendWebhook(app, payload)).statusCode).toBe(200);

    expect((await environmentDatabase(storageRoot, receiver.projectEnvironmentId)).events).toHaveLength(1);
  });

  it('counts each newly stored Event in the receiving environment’s Usage, a repeat not again', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });
    const payload = {
      events: [
        providerEvent({ type: 'message.received', key: 'u-1', data: { address, text: 'One' } }),
        providerEvent({ type: 'message.received', key: 'u-2', data: { address, text: 'Two' } }),
      ],
    };

    expect((await sendWebhook(app, payload)).statusCode).toBe(200);
    expect((await sendWebhook(app, payload)).statusCode).toBe(200);

    expect(await usageRowsOf(receiver.projectEnvironmentId)).toEqual([
      expect.objectContaining({
        tenantId: receiver.tenant.tenantId,
        projectId: receiver.projectId,
        service: INBOX_SERVICE,
        calls: 0,
        events: 2,
      }),
    ]);
  });

  it('writes Event files to disk beside their event_files rows', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });

    const res = await sendWebhook(app, {
      events: [
        providerEvent({
          type: 'message.received',
          key: 'with-files',
          data: { address, text: 'See attached' },
          files: [
            { name: 'notes.txt', mimeType: 'text/plain', text: 'first file' },
            { name: '../../escape.txt', mimeType: 'text/plain', text: 'second file' },
          ],
        }),
      ],
    });

    expect(res.statusCode).toBe(200);
    const { events, eventFiles } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    const [event] = events;
    expect(eventFiles).toEqual([
      expect.objectContaining({ eventId: event?.id, name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 10 }),
      expect.objectContaining({ eventId: event?.id, name: '.._.._escape.txt', sizeBytes: 11 }),
    ]);
    expect(eventFiles[0]?.path).toBe(`/workspace/data/external-services/files/${event?.id}/notes.txt`);
    expect(await fileOnDisk(storageRoot, receiver.projectEnvironmentId, eventFiles[0]?.path ?? '')).toBe('first file');
    expect(await fileOnDisk(storageRoot, receiver.projectEnvironmentId, eventFiles[1]?.path ?? '')).toBe('second file');
  });

  it("stores a built-in's Events whatever the size of their files", async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });
    const twentyMegabytes = 20 * 1024 * 1024;

    const res = await sendWebhook(app, {
      events: [
        providerEvent({
          type: 'message.received',
          key: 'with-a-large-file',
          data: { address, text: 'A large recording' },
          files: [{ name: 'recording.bin', mimeType: 'application/octet-stream', text: 'x', repeat: twentyMegabytes }],
        }),
      ],
    });

    expect(res.statusCode, res.body).toBe(200);
    const { eventFiles } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(eventFiles).toEqual([expect.objectContaining({ name: 'recording.bin', sizeBytes: twentyMegabytes })]);
  });

  it('hands multipart uploads to the service and stores the files it returns', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });

    const res = await sendMultipartWebhook(
      app,
      {
        events: [
          providerEvent({
            type: 'message.received',
            key: 'uploaded',
            data: { address, text: 'Scan attached' },
            withUploads: true,
          }),
        ],
      },
      [{ filename: 'scan.pdf', mimeType: 'application/pdf', text: '%PDF-fixture' }]
    );

    expect(res.statusCode).toBe(200);
    const { eventFiles } = await environmentDatabase(storageRoot, receiver.projectEnvironmentId);
    expect(eventFiles).toEqual([expect.objectContaining({ name: 'scan.pdf', mimeType: 'application/pdf' })]);
    expect(await fileOnDisk(storageRoot, receiver.projectEnvironmentId, eventFiles[0]?.path ?? '')).toBe(
      '%PDF-fixture'
    );
  });

  it("answers the provider with the service's own response", async () => {
    const res = await sendWebhook(app, { challenge: 'echo-me' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: 'echo-me' });
  });

  it('never lets the service answer the provider with a page, a redirect or its own security headers', async () => {
    const res = await sendWebhook(app, {
      answer: {
        status: 302,
        headers: {
          'content-type': 'text/html',
          location: 'https://evil.example/',
          'set-cookie': 'session=stolen',
          'content-security-policy': 'default-src *',
          'x-hook-secret': 'echoed-handshake',
          'x-accel-redirect': '/internal/secrets',
          'x-forwarded-host': 'evil.example',
        },
        body: '<script>alert(1)</script>',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-hook-secret']).toBe('echoed-handshake');
    expect(res.headers['x-accel-redirect']).toBeUndefined();
    expect(res.headers['x-forwarded-host']).toBeUndefined();
  });

  it('keeps a JSON, XML or plain-text answer the provider expects', async () => {
    const res = await sendWebhook(app, {
      answer: { status: 202, headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: '<Response/>' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.headers['content-type']).toBe('text/xml; charset=utf-8');
    expect(res.body).toBe('<Response/>');
  });

  it('withholds an answer that carries a secret the service was given and stores nothing', async () => {
    const address = `desk-${crypto.randomUUID()}`;
    const receiver = await receivingEnvironment(app, { address, receive: { 'message.received': true } });

    const res = await sendWebhook(app, {
      leak: true,
      events: [providerEvent({ type: 'message.received', key: 'leak', data: { address, text: 'Oops' } })],
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'secret-in-response' });
    expect(res.body).not.toContain(INBOX_SIGNING_KEY);
    expect((await environmentDatabase(storageRoot, receiver.projectEnvironmentId)).events).toEqual([]);
  });

  it('answers 503 while the service has no complete Service configuration', async () => {
    await forgetPlatformServiceConfiguration(INBOX_SERVICE);

    const res = await sendWebhook(app, { events: [] });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'service-not-configured' });
    expect(await latestInboundCall()).toMatchObject({ decision: 'refused', status: 503 });
  });
});

describe('the webhook front door for a service without inbound', () => {
  let harness: ExternalServicesTestApp;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('answers 404', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/external-services/webhooks/${FIXTURE_SERVICE}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain(PROBLEM_JSON);
    expect(res.json()).toMatchObject({ status: 404, code: 'no-inbound' });
    expect(await latestInboundCall(FIXTURE_SERVICE)).toMatchObject({ decision: 'refused', status: 404 });
  });

  it('answers 404 for a name no service has', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/external-services/webhooks/nobody',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'unknown-service' });
  });
});
