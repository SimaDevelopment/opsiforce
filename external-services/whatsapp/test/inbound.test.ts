import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signedHeaders, textMessage, webhook } from './fixtures/whapi.ts';
import { apiUrl, sales, support, whatsapp } from './whatsapp.ts';

const anna = '491701234567@s.whatsapp.net';
const orders = '120363000000000000@g.us';

const projectConfigurations = [
  {
    projectId: 'p-1',
    projectEnvironmentId: 'pe-anna',
    projectConfiguration: { channels: [{ id: 'li_1', channel: sales.id, chats: [anna] }] },
  },
  {
    projectId: 'p-2',
    projectEnvironmentId: 'pe-both',
    projectConfiguration: {
      channels: [
        { id: 'li_2', channel: sales.id, chats: [anna, orders] },
        { id: 'li_3', channel: support.id, chats: [anna] },
      ],
    },
  },
  {
    projectId: 'p-3',
    projectEnvironmentId: 'pe-support',
    projectConfiguration: { channels: [{ id: 'li_4', channel: support.id, chats: [anna, orders] }] },
  },
];

function receiving() {
  return whatsapp({ projectConfigurations });
}

describe('whatsapp webhook', () => {
  it('delivers a message to the environments listening to this number’s chat', async () => {
    const service = receiving();

    const res = await service.webhook(webhook([textMessage]), signedHeaders());

    assert.equal(res.status, 200);
    assert.deepEqual(service.deliveries, [
      {
        to: ['pe-anna', 'pe-both'],
        event: {
          type: 'message.received',
          key: 'wamid.text-1',
          occurredAt: '2026-10-08T12:00:00.000Z',
          data: {
            channel: 'li_sales',
            channelId: 'SALES-7Q2',
            chatId: anna,
            chatName: 'Anna',
            messageId: 'wamid.text-1',
            type: 'text',
            from: '491701234567',
            fromName: 'Anna',
            fromMe: false,
            text: 'Two boxes, please',
            sentAt: '2026-10-08T12:00:00.000Z',
            source: 'mobile',
            message: textMessage,
          },
        },
      },
    ]);
  });

  it('delivers nothing for a chat no environment listens to, and still answers 200', async () => {
    const service = receiving();
    const stranger = { ...textMessage, chat_id: '4915550000000@s.whatsapp.net' };

    const res = await service.webhook(webhook([stranger]), signedHeaders());

    assert.equal(res.status, 200);
    assert.deepEqual(service.deliveries, []);
  });

  it('refuses a webhook whose secret is not the number’s own', async () => {
    const service = receiving();

    const res = await service.webhook(webhook([textMessage]), signedHeaders(support.webhookSecret));

    assert.equal(res.status, 401);
    assert.deepEqual(service.deliveries, []);
  });

  it('refuses a webhook with no secret header', async () => {
    const res = await receiving().webhook(webhook([textMessage]), { 'content-type': 'application/json' });

    assert.equal(res.status, 401);
  });

  it('refuses a webhook for a channel that is not one of the numbers', async () => {
    const res = await receiving().webhook(webhook([textMessage], { channelId: 'UNKNOWN-1' }), signedHeaders());

    assert.equal(res.status, 401);
  });

  it('answers 503 so Whapi retries when a receiver is over the Event cap', async () => {
    const service = whatsapp({ projectConfigurations, deliveryResults: { 'pe-both': 'over-cap' } });

    const res = await service.webhook(webhook([textMessage]), signedHeaders());

    assert.equal(res.status, 503);
  });

  it('gives each message its own Event and skips entries without an id or chat', async () => {
    const group = { ...textMessage, id: 'wamid.text-2', chat_id: orders, chat_name: 'Orders' };
    const service = receiving();

    await service.webhook(webhook([textMessage, { type: 'text' }, group]), signedHeaders());

    assert.deepEqual(
      service.deliveries.map(({ event, to }) => [event.key, to]),
      [
        ['wamid.text-1', ['pe-anna', 'pe-both']],
        ['wamid.text-2', ['pe-both']],
      ]
    );
  });

  it('answers a webhook with no messages with 200', async () => {
    const service = receiving();

    const res = await service.webhook(webhook([]), signedHeaders());

    assert.equal(res.status, 200);
    assert.deepEqual(service.deliveries, []);
  });

  it('stores a media message’s bytes, fetched with the number’s token, as the Event’s file', async () => {
    const photo = {
      ...textMessage,
      id: 'wamid.photo-1',
      type: 'image',
      text: undefined,
      image: { id: 'media-77', mime_type: 'image/jpeg', file_size: 5, caption: 'The pallet' },
    };
    const service = receiving();
    service.upstream.reply(`GET ${apiUrl}/media/media-77`, new TextEncoder().encode('jpeg!'), {
      headers: { 'content-type': 'image/jpeg' },
    });

    await service.webhook(webhook([photo]), signedHeaders());

    const [delivery] = service.deliveries;
    assert.equal(delivery?.event.data.text, 'The pallet');
    assert.equal(delivery?.event.data.caption, 'The pallet');
    assert.deepEqual(delivery?.event.data.media, { id: 'media-77', mimeType: 'image/jpeg', size: 5, stored: true });
    assert.deepEqual(
      delivery?.event.files?.map((file) => ({ ...file, bytes: new TextDecoder().decode(file.bytes) })),
      [{ name: 'media-77.jpg', mimeType: 'image/jpeg', bytes: 'jpeg!' }]
    );
    assert.equal(service.upstream.requests[0]?.headers.authorization, 'Bearer sales-api-token');
  });

  it('falls back to the media link Whapi sent when the media endpoint fails', async () => {
    const document = {
      ...textMessage,
      id: 'wamid.doc-1',
      type: 'document',
      document: {
        id: 'media-88',
        mime_type: 'application/pdf',
        filename: 'order.pdf',
        link: 'https://cdn.whapi.example.com/media-88',
      },
    };
    const service = receiving();
    service.upstream.reply(`GET ${apiUrl}/media/media-88`, { error: 'gone' }, { status: 404 });
    service.upstream.reply('GET https://cdn.whapi.example.com/media-88', '%PDF-1.7');

    await service.webhook(webhook([document]), signedHeaders());

    const [delivery] = service.deliveries;
    assert.deepEqual(delivery?.event.data.media, {
      id: 'media-88',
      mimeType: 'application/pdf',
      filename: 'order.pdf',
      stored: true,
    });
    assert.deepEqual(
      delivery?.event.files?.map((file) => file.name),
      ['order.pdf']
    );
  });

  it('keeps a media message whose bytes cannot be fetched, marked as not stored', async () => {
    const voice = {
      ...textMessage,
      id: 'wamid.voice-1',
      type: 'voice',
      text: undefined,
      voice: { id: 'media-99', mime_type: 'audio/ogg', file_size: 2048 },
    };
    const service = receiving();
    service.upstream.reply(`GET ${apiUrl}/media/media-99`, { error: 'boom' }, { status: 500 });

    const res = await service.webhook(webhook([voice]), signedHeaders());

    const [delivery] = service.deliveries;
    assert.equal(res.status, 200);
    assert.deepEqual(delivery?.event.data.media, { id: 'media-99', mimeType: 'audio/ogg', size: 2048, stored: false });
    assert.equal(delivery?.event.files, undefined);
    assert.equal(delivery?.event.data.text, undefined);
  });

  it('stores what it fetched in time and marks the media that did not answer as not stored', async () => {
    const voiceOf = (id: string, mediaId: string) => ({
      ...textMessage,
      id,
      type: 'voice',
      text: undefined,
      voice: { id: mediaId, mime_type: 'audio/ogg', file_size: 5 },
    });
    const service = receiving();
    const never = () => new Promise(() => undefined);
    service.upstream.reply(`GET ${apiUrl}/media/media-slow-1`, never);
    service.upstream.reply(`GET ${apiUrl}/media/media-slow-2`, never);
    service.upstream.reply(`GET ${apiUrl}/media/media-fast`, new TextEncoder().encode('oggs!'), {
      headers: { 'content-type': 'audio/ogg' },
    });

    const res = await service.webhook(
      webhook([
        voiceOf('wamid.slow-1', 'media-slow-1'),
        voiceOf('wamid.slow-2', 'media-slow-2'),
        voiceOf('wamid.fast', 'media-fast'),
      ]),
      signedHeaders()
    );

    assert.equal(res.status, 200);
    assert.deepEqual(
      service.deliveries.map(({ event }) => [event.key, (event.data.media as { stored: boolean }).stored]),
      [
        ['wamid.slow-1', false],
        ['wamid.slow-2', false],
        ['wamid.fast', true],
      ]
    );
  });

  it('stops reading media that streams past the size limit without declaring its length', async () => {
    const limit = 32 * 1024 * 1024;
    const chunk = new Uint8Array(1024 * 1024);
    let streamed = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            streamed += chunk.byteLength;
            controller.enqueue(chunk);
          },
        })
      );
    const video = {
      ...textMessage,
      id: 'wamid.video-1',
      type: 'video',
      text: undefined,
      video: { id: 'media-endless', mime_type: 'video/mp4' },
    };
    const service = receiving();
    service.upstream.reply(`GET ${apiUrl}/media/media-endless`, endless);

    const startedAt = Date.now();
    const res = await service.webhook(webhook([video]), signedHeaders());

    const [delivery] = service.deliveries;
    assert.equal(res.status, 200);
    assert.deepEqual(delivery?.event.data.media, { id: 'media-endless', mimeType: 'video/mp4', stored: false });
    assert.equal(delivery?.event.files, undefined);
    assert.ok(streamed <= limit + 8 * chunk.byteLength, `read ${streamed} bytes`);
    assert.ok(Date.now() - startedAt < 10_000, 'stopped before the media budget ran out');
  });
});
