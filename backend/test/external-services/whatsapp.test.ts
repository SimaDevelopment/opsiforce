import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  storedPlatformServiceConfiguration,
  type PersonFixture,
} from './support/fixtures';
import { gateCaller, storedProjectConfiguration } from './support/gate';
import {
  channelsOf,
  retryServiceConfigurationHook,
  rotateServiceConfiguration,
  saveServiceConfiguration,
  type Revealed,
} from './support/generating';
import { environmentDatabase } from './support/inbound';
import { legacyRows, storedBeforeV2 } from './support/incoming-email';
import {
  fakeWhapi,
  forgetV1WhatsApp,
  sendWhatsapp,
  storeV1Number,
  storeV1Wiring,
  WHAPI_URL,
  WHATSAPP_SERVICE,
  type FakeWhapi,
} from './support/whatsapp';

const PUBLIC_URL = 'https://opsiforce.example.com';
const REGISTERED_WEBHOOK_URL = `${PUBLIC_URL}/api/external-services/webhooks/whatsapp`;

function bootWith(options: { whapiApiUrl?: string; storageRoot?: string } = {}) {
  return createExternalServicesTestApp({
    builtInsDir: shippedBuiltInServicesDir(),
    env: {
      OPSIFORCE_PUBLIC_URL: PUBLIC_URL,
      ...(options.storageRoot ? { STORAGE_MOUNT_PATH: options.storageRoot } : {}),
    },
    config: { whapiApiUrl: options.whapiApiUrl ?? 'https://gate.whapi.cloud' },
  });
}

async function forgetWhatsApp(): Promise<void> {
  const harness = await bootWith();
  await forgetPlatformServiceConfiguration(WHATSAPP_SERVICE);
  await forgetV1WhatsApp();
  await harness.close();
}

const SALES = {
  channelId: `SALES-${crypto.randomUUID().slice(0, 6)}`,
  apiToken: 'sales-api-token',
  webhookSecret: 'sales-webhook-secret-from-v1',
  label: 'Sales number',
};

const UNLABELLED = {
  channelId: `SUPPORT-${crypto.randomUUID().slice(0, 6)}`,
  apiToken: 'support-api-token',
  webhookSecret: 'support-webhook-secret-from-v1',
  label: null,
};

const ANNA = '491701234567@s.whatsapp.net';
const ORDERS = '120363000000000000@g.us';

async function storedChannels(): Promise<Record<string, unknown>[]> {
  return ((await storedPlatformServiceConfiguration(WHATSAPP_SERVICE))?.channels ?? []) as Record<string, unknown>[];
}

async function itemIdOf(channelId: string): Promise<string> {
  const item = (await storedChannels()).find((channel) => channel.channelId === channelId);
  if (!item) throw new Error(`No item for ${channelId}`);
  return item.id as string;
}

describe('WhatsApp on a deployment upgraded with v1 numbers', () => {
  let storageRoot: string;
  let whapi: FakeWhapi;
  let upgraded: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let wired: string;
  let wiredToADeletedNumber: string;
  let partlyDeleted: string;
  let legacy: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'whatsapp-upgrade-'));
    await forgetWhatsApp();
    const v1 = await bootWith({ storageRoot });
    [wired, wiredToADeletedNumber, partlyDeleted, legacy] = await Promise.all(
      [1, 2, 3, 4].map(async () => (await gateCaller(v1.app)).projectEnvironmentId)
    );
    await v1.close();

    await storeV1Number(SALES);
    await storeV1Number(UNLABELLED);
    await storeV1Wiring(wired, [
      {
        channelId: SALES.channelId,
        allowedChats: [
          { chatId: ANNA, chatName: 'Anna' },
          { chatId: ORDERS, chatName: null },
        ],
      },
    ]);
    await storeV1Wiring(wiredToADeletedNumber, [
      { channelId: 'DELETED-1', allowedChats: [{ chatId: ANNA, chatName: 'Anna' }] },
    ]);
    await storeV1Wiring(partlyDeleted, [
      { channelId: 'DELETED-1', allowedChats: [{ chatId: ANNA, chatName: 'Anna' }] },
      { channelId: UNLABELLED.channelId, allowedChats: [{ chatId: ORDERS, chatName: 'Orders' }] },
    ]);
    await storeV1Wiring(legacy, [
      { channelId: UNLABELLED.channelId, allowedChats: [{ chatId: ANNA, chatName: 'Anna' }] },
    ]);
    await storedBeforeV2(storageRoot, legacy, { service: WHATSAPP_SERVICE, delivered: true });

    whapi = fakeWhapi();
    upgraded = await bootWith({ whapiApiUrl: WHAPI_URL, storageRoot });
    app = upgraded.app;
    await upgraded.listen();
  });

  afterAll(async () => {
    await upgraded.close();
    whapi.restore();
    await forgetWhatsApp();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('lists the existing numbers as items with their labels, without registering anything with Whapi again', async () => {
    const operator = await platformOperator(app);
    const view = await app.inject({
      method: 'GET',
      url: `/api/external-services/platform/services/${await builtInServiceId(WHATSAPP_SERVICE)}`,
      headers: operator.headers,
    });

    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ available: true, serviceConfiguration: { values: { apiUrl: WHAPI_URL } } });
    expect(
      channelsOf(view.json())
        .map((channel) => [(channel as unknown as { channelId: string }).channelId, channel.label])
        .toSorted()
    ).toEqual([
      [SALES.channelId, 'Sales number'],
      [UNLABELLED.channelId, UNLABELLED.channelId],
    ]);
    expect(whapi.requests).toEqual([]);
  });

  it('keeps each number’s token and webhook secret, sealed at the item’s own place', async () => {
    const stored = JSON.stringify(await storedChannels());
    expect(stored).not.toContain(SALES.apiToken);
    expect(stored).not.toContain(SALES.webhookSecret);

    const id = await itemIdOf(SALES.channelId);
    const sales = (await storedChannels()).find((channel) => channel.id === id);
    const sealer = app.get(SecretSealer);
    const serviceId = await builtInServiceId(WHATSAPP_SERVICE);
    expect(sealer.open(sales?.webhookSecret as never, `${serviceId}|platform|channels.${id}.webhookSecret`)).toBe(
      SALES.webhookSecret
    );
    expect(sealer.open(sales?.apiToken as never, `${serviceId}|platform|channels.${id}.apiToken`)).toBe(SALES.apiToken);
  });

  it('turns each environment’s chat allowlist into its Project configuration, with the chat names as labels', async () => {
    const values = await storedProjectConfiguration(WHATSAPP_SERVICE, wired);

    expect(values).toMatchObject({
      channels: [{ channel: await itemIdOf(SALES.channelId), chats: [ANNA, ORDERS] }],
      _labels: { chats: { [ANNA]: 'Anna' } },
    });
    expect(values).not.toHaveProperty('receive');
    expect(values).not.toHaveProperty('operations');
    expect((values?.channels as { id?: string }[] | undefined)?.[0]?.id).toMatch(/^li_/);
  });

  it('drops a configuration naming only a deleted number, and the deleted number from a mixed one', async () => {
    const dropped = await storedProjectConfiguration(WHATSAPP_SERVICE, wiredToADeletedNumber);
    expect(dropped?.channels).toBeUndefined();
    expect(await storedProjectConfiguration(WHATSAPP_SERVICE, partlyDeleted)).toMatchObject({
      channels: [{ channel: await itemIdOf(UNLABELLED.channelId), chats: [ORDERS] }],
      _labels: { chats: { [ORDERS]: 'Orders' } },
    });
  });

  it('keeps receiving with the secret Whapi already holds, through the built-ins adapter', async () => {
    const res = await sendWhatsapp(app, {
      channelId: SALES.channelId,
      secret: SALES.webhookSecret,
      messages: [{ id: `wamid.${crypto.randomUUID()}`, chatId: ANNA }],
    });

    expect(res.status, await res.text()).toBe(200);
    const { events } = await environmentDatabase(storageRoot, wired);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      service: WHATSAPP_SERVICE,
      type: 'message.received',
      data: { channel: await itemIdOf(SALES.channelId), channelId: SALES.channelId, chatId: ANNA },
    });
    expect((await environmentDatabase(storageRoot, partlyDeleted)).events).toEqual([]);
  });

  it('writes a messages row for an environment wired in v1 that had received nothing yet', async () => {
    const messageId = `wamid.${crypto.randomUUID()}`;
    const res = await sendWhatsapp(app, {
      channelId: SALES.channelId,
      secret: SALES.webhookSecret,
      messages: [{ id: messageId, chatId: ORDERS }],
    });

    expect(res.status, await res.text()).toBe(200);
    const { messages } = await legacyRows(storageRoot, wired);
    expect(messages.map((message) => message.provider_message_id)).toContain(messageId);
  });

  it('refuses a webhook with another secret and stores nothing', async () => {
    const res = await sendWhatsapp(app, {
      channelId: SALES.channelId,
      secret: UNLABELLED.webhookSecret,
      messages: [{ id: `wamid.${crypto.randomUUID()}`, chatId: ANNA }],
    });

    expect(res.status).toBe(401);
    expect((await res.json()).message).toMatch(/does not match a configured number/);
  });

  it('writes a legacy environment’s messages row in the v1 shape next to the Event', async () => {
    const messageId = `wamid.${crypto.randomUUID()}`;
    const res = await sendWhatsapp(app, {
      channelId: UNLABELLED.channelId,
      secret: UNLABELLED.webhookSecret,
      messages: [{ id: messageId, chatId: ANNA, text: 'Legacy hello' }],
    });

    expect(res.status, await res.text()).toBe(200);
    const { messages } = await legacyRows(storageRoot, legacy);
    const row = messages.find((message) => message.provider_message_id === messageId);
    expect(row).toMatchObject({
      service: WHATSAPP_SERVICE,
      routing_key: ANNA,
      sender: '491701234567',
      text_body: 'Legacy hello',
    });
    expect(JSON.parse(row?.payload as string)).toEqual({
      channel_id: UNLABELLED.channelId,
      chat_name: 'Anna',
      from_me: false,
      from_name: 'Anna',
      type: 'text',
      sent_at: '2026-10-08T12:00:00.000Z',
      source: null,
      caption: null,
      media_id: null,
      media_fetch_failed: false,
    });
    expect(JSON.parse(row?.raw_payload as string)).toMatchObject({ id: messageId, chat_id: ANNA });
  });

  it('never imports twice: a later boot keeps what the operator has', async () => {
    const before = await storedPlatformServiceConfiguration(WHATSAPP_SERVICE);
    const later = await bootWith({ whapiApiUrl: 'https://other-whapi.test', storageRoot });
    try {
      expect(await storedPlatformServiceConfiguration(WHATSAPP_SERVICE)).toEqual(before);
    } finally {
      await later.close();
    }
  });
});

describe('operating WhatsApp numbers from the service page', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let operator: PersonFixture;
  let serviceId: string;
  let whapi: FakeWhapi;

  beforeAll(async () => {
    await forgetWhatsApp();
    harness = await bootWith();
    app = harness.app;
    operator = await platformOperator(app);
    serviceId = await builtInServiceId(WHATSAPP_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(WHATSAPP_SERVICE);
    whapi = fakeWhapi();
  });

  afterEach(() => {
    whapi.restore();
  });

  const newNumber = { channelId: 'NEW-1', label: 'New number', apiToken: 'new-api-token' };

  function patchesOf(): { webhooks: { url: string; headers: Record<string, string> }[] }[] {
    return whapi.requests
      .filter((request) => request.method === 'PATCH' && request.path === '/settings')
      .map((request) => request.body as { webhooks: { url: string; headers: Record<string, string> }[] });
  }

  it('is Available with no numbers', async () => {
    const view = await app.inject({
      method: 'GET',
      url: `/api/external-services/platform/services/${serviceId}`,
      headers: operator.headers,
    });

    expect(view.json()).toMatchObject({ available: true });
  });

  it('registers a new number’s webhook with the public URL, never a forged Host, and shows its secret once', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/external-services/platform/services/${serviceId}/configuration`,
      headers: { ...operator.headers, host: 'evil.example', 'x-forwarded-host': 'evil.example' },
      payload: { values: { apiUrl: WHAPI_URL, channels: [newNumber] } },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().hookFailure).toBeNull();
    const [channel] = channelsOf(res.json());
    const revealed = (res.json().revealed as Revealed[]).find(
      (entry) => entry.path === `channels.${channel?.id}.webhookSecret`
    );
    expect(revealed?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(patchesOf()).toEqual([
      {
        webhooks: [
          {
            url: REGISTERED_WEBHOOK_URL,
            mode: 'body',
            headers: { 'X-Opsiforce-Webhook-Secret': revealed?.value },
            events: [{ type: 'messages', method: 'post' }],
          },
        ],
      },
    ]);
    expect(whapi.requests.every((request) => request.authorization === 'Bearer new-api-token')).toBe(true);
  });

  it('re-registers on Rotate; a refused push keeps the new secret and offers Retry', async () => {
    const saved = await saveServiceConfiguration(app, operator, serviceId, {
      apiUrl: WHAPI_URL,
      channels: [newNumber],
    });
    const [channel] = channelsOf(saved.json());
    whapi.refuseWith(500);

    const rotated = await rotateServiceConfiguration(app, operator, serviceId, {
      field: 'webhookSecret',
      item: channel?.id,
    });

    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().hookFailure).toMatchObject({ code: 'service-failed' });
    const secret = (rotated.json().revealed as Revealed[])[0]?.value;
    expect(secret).toBeTruthy();

    whapi.refuseWith(null);
    const retried = await retryServiceConfigurationHook(app, operator, serviceId);

    expect(retried.json().hookFailure).toBeNull();
    expect(patchesOf().at(-1)?.webhooks[0]?.headers['X-Opsiforce-Webhook-Secret']).toBe(secret);
  });

  it('answers the old WhatsApp admin route with 404', async () => {
    const admin = await app.inject({
      method: 'GET',
      url: '/api/external-services/admin/whatsapp/channels',
      headers: operator.headers,
    });

    expect(admin.statusCode).toBe(404);
  });
});
