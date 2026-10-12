import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { db } from '../../../db';
import { externalServiceConfig, externalServiceResource } from '../../../db/schema';
import { encryptResourceValue } from '../../../src/common/secret-crypto';
import { encryptionKeyFrom } from '../../../src/sealing/secret-sealer';

export const WHATSAPP_SERVICE = 'whatsapp';
export const WHATSAPP_WEBHOOK_PATH = `/api/external-services/webhooks/${WHATSAPP_SERVICE}`;
export const WHAPI_URL = 'https://whapi.test';
export const RECEIVING_WHATSAPP = { receive: { 'message.received': true } };

export interface V1Number {
  channelId: string;
  apiToken: string;
  webhookSecret: string;
  label: string | null;
}

export async function storeV1Number(number: V1Number): Promise<void> {
  const key = encryptionKeyFrom(process.env.EXTERNAL_SERVICES_ENCRYPTION_KEY ?? '');
  const { channelId, ...resource } = number;
  await db.insert(externalServiceResource).values({
    service: WHATSAPP_SERVICE,
    resourceKey: channelId,
    value: encryptResourceValue(key, resource),
  });
}

export type V1Wiring = {
  channelId: string;
  allowedChats: { chatId: string; chatName: string | null }[];
};

export async function storeV1Wiring(projectEnvironmentId: string, channels: V1Wiring[]): Promise<void> {
  await db
    .insert(externalServiceConfig)
    .values({ service: WHATSAPP_SERVICE, projectEnvironmentId, value: { channels } });
}

export async function forgetV1WhatsApp(): Promise<void> {
  await db.delete(externalServiceResource).where(eq(externalServiceResource.service, WHATSAPP_SERVICE));
  await db.delete(externalServiceConfig).where(eq(externalServiceConfig.service, WHATSAPP_SERVICE));
}

export interface WhapiRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

export interface FakeWhapi {
  requests: WhapiRequest[];
  refuseWith: (status: number | null) => void;
  restore: () => void;
}

export function fakeWhapi(): FakeWhapi {
  const original = globalThis.fetch;
  const requests: WhapiRequest[] = [];
  let refusal: number | null = null;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, init) => {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (url.origin !== WHAPI_URL) return original(resource, init);
    const text = request.body === null ? '' : await request.text();
    requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get('authorization'),
      body: text === '' ? null : JSON.parse(text),
    });
    if (refusal !== null) return Response.json({ error: { message: 'refused' } }, { status: refusal });
    if (url.pathname === '/settings' && request.method === 'GET') return Response.json({ webhooks: [] });
    return Response.json({});
  });
  return {
    requests,
    refuseWith: (status) => {
      refusal = status;
    },
    restore: () => spy.mockRestore(),
  };
}

export interface WhatsappMessage {
  id: string;
  chatId: string;
  text?: string;
}

export function sendWhatsapp(
  app: NestFastifyApplication,
  delivery: { channelId: string; secret: string; messages: WhatsappMessage[] }
) {
  return app.inject({
    method: 'POST',
    url: WHATSAPP_WEBHOOK_PATH,
    headers: { 'content-type': 'application/json', 'x-opsiforce-webhook-secret': delivery.secret },
    payload: JSON.stringify({
      channel_id: delivery.channelId,
      event: { type: 'messages', event: 'post' },
      messages: delivery.messages.map((message) => ({
        id: message.id,
        from_me: false,
        type: 'text',
        chat_id: message.chatId,
        chat_name: 'Anna',
        timestamp: 1791460800,
        from: message.chatId.split('@')[0],
        from_name: 'Anna',
        text: { body: message.text ?? 'Two boxes, please' },
      })),
    }),
  });
}
