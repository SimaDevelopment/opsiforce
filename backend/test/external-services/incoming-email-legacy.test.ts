import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { startFakeApp, type FakeApp } from './support/fake-app';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { podComesUp, ringDoorbells } from './support/doorbell';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import { configuringProject, saveProjectService, type ConfiguringProject } from './support/generating';
import { environmentDatabase } from './support/inbound';
import {
  EMAIL_SERVICE,
  legacyRows,
  MAILGUN_SIGNING_KEY,
  RECEIVING_DOMAIN,
  RECEIVING_EMAIL,
  sendMail,
  storedBeforeV2,
  storeV1Address,
} from './support/incoming-email';

const DOORBELL_PATH = `/api/external-services/${EMAIL_SERVICE}`;

describe('incoming email in an environment whose App was built on the messages table', () => {
  let storageRoot: string;
  let fakeApp: FakeApp;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;

  const boot = () =>
    createExternalServicesTestApp({
      builtInsDir: shippedBuiltInServicesDir(),
      env: { STORAGE_MOUNT_PATH: storageRoot },
      config: {
        appPort: fakeApp.port,
        mailgunReceiveDomain: RECEIVING_DOMAIN,
        mailgunWebhookSigningKey: MAILGUN_SIGNING_KEY,
      },
    });

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'incoming-email-legacy-'));
    fakeApp = await startFakeApp();
    const before = await boot();
    await forgetPlatformServiceConfiguration(EMAIL_SERVICE);
    await before.close();
    harness = await boot();
    app = harness.app;
    serviceId = await builtInServiceId(EMAIL_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
    await fakeApp.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    fakeApp.received.length = 0;
    fakeApp.answer(200);
  });

  async function receivingEnvironment(): Promise<{ project: ConfiguringProject; localPart: string }> {
    const project = await configuringProject(app);
    const saved = await saveProjectService(app, project, serviceId, RECEIVING_EMAIL);
    await podComesUp(app, project.projectEnvironmentId);
    return { project, localPart: saved.json().projectConfiguration.values.localPart as string };
  }

  it('writes the email as a messages row with its attachments next to the Event, rings with both ids and stamps both', async () => {
    const { project, localPart } = await receivingEnvironment();
    const oldRowId = await storedBeforeV2(storageRoot, project.projectEnvironmentId, {
      service: EMAIL_SERVICE,
      delivered: true,
    });

    const res = await sendMail(app, {
      to: `${localPart}@${RECEIVING_DOMAIN}`,
      messageId: '<order-7@customer.example>',
      subject: 'Order 7',
      text: 'Two boxes, please.',
      attachments: [{ filename: 'order.csv', mimeType: 'text/csv', text: 'sku,qty\nbox,2\n' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, project.projectEnvironmentId);
    const { messages, attachments } = await legacyRows(storageRoot, project.projectEnvironmentId);
    const newRow = messages.find((row) => row.id !== oldRowId);
    expect(newRow).toMatchObject({
      service: EMAIL_SERVICE,
      provider_message_id: '<order-7@customer.example>',
      routing_key: `${localPart}@${RECEIVING_DOMAIN}`,
      sender: 'ann@customer.example',
      text_body: 'Two boxes, please.',
    });
    expect(JSON.parse(newRow?.payload as string)).toMatchObject({
      from_header: 'Ann Customer <ann@customer.example>',
      subject: 'Order 7',
      body_plain: 'Two boxes, please.',
      message_headers: JSON.stringify([['Message-Id', '<order-7@customer.example>']]),
    });
    expect(attachments).toEqual([
      expect.objectContaining({
        message_id: newRow?.id,
        filename: 'order.csv',
        content_type: 'text/csv',
        size_bytes: 14,
      }),
    ]);
    expect(Buffer.from(attachments[0]?.content as Uint8Array).toString('utf8')).toBe('sku,qty\nbox,2\n');
    expect(fakeApp.received).toEqual([
      {
        path: DOORBELL_PATH,
        authorization: undefined,
        body: { service: EMAIL_SERVICE, rowIds: [newRow?.id], eventIds: events.map((event) => event.id) },
      },
    ]);
    expect(events.every((event) => event.appDeliveredAt !== null)).toBe(true);
    expect(messages.find((row) => row.id === oldRowId)?.app_delivered_at).toBe('2026-09-01T10:00:05.000Z');
    expect(newRow?.app_delivered_at).not.toBeNull();
  });

  it('carries an old row the App never got along with the next ring', async () => {
    const { project, localPart } = await receivingEnvironment();
    const waitingRowId = await storedBeforeV2(storageRoot, project.projectEnvironmentId, {
      service: EMAIL_SERVICE,
      delivered: false,
    });

    await sendMail(app, { to: `${localPart}@${RECEIVING_DOMAIN}` });
    await ringDoorbells(app);

    const { messages } = await legacyRows(storageRoot, project.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body.rowIds)).toEqual([messages.map((row) => row.id)]);
    expect(messages.map((row) => row.id)).toContain(waitingRowId);
  });

  it('writes a messages row and rings with its id for an environment wired in v1 whose mailbox was still empty', async () => {
    const { project, localPart } = await receivingEnvironment();
    await storeV1Address(project.projectEnvironmentId, `${localPart}@${RECEIVING_DOMAIN}`);

    await sendMail(app, { to: `${localPart}@${RECEIVING_DOMAIN}`, messageId: '<first@customer.example>' });
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, project.projectEnvironmentId);
    const { messages } = await legacyRows(storageRoot, project.projectEnvironmentId);
    expect(messages).toEqual([
      expect.objectContaining({ service: EMAIL_SERVICE, provider_message_id: '<first@customer.example>' }),
    ]);
    expect(fakeApp.received.map((delivery) => delivery.body)).toEqual([
      { service: EMAIL_SERVICE, rowIds: [messages[0]?.id], eventIds: events.map((event) => event.id) },
    ]);
  });

  it('keeps rowIds out of the ring and the messages table empty for an environment built after the upgrade', async () => {
    const { project, localPart } = await receivingEnvironment();

    await sendMail(app, { to: `${localPart}@${RECEIVING_DOMAIN}` });
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, project.projectEnvironmentId);
    expect(fakeApp.received.map((delivery) => delivery.body)).toEqual([
      { service: EMAIL_SERVICE, eventIds: events.map((event) => event.id) },
    ]);
    expect((await legacyRows(storageRoot, project.projectEnvironmentId)).messages).toEqual([]);
  });
});
