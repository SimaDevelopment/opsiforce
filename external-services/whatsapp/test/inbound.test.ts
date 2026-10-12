import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signedHeaders, textMessage, webhook } from './fixtures/whapi.ts';
import { apiUrl, support, whatsapp } from './whatsapp.ts';

describe('whatsapp inbound', () => {
  it('turns a Whapi messages webhook into a message.received Event of the number and chat', async () => {
    const res = await whatsapp().inbound({ headers: signedHeaders(), rawBody: webhook([textMessage]) });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.events, [
      {
        type: 'message.received',
        key: 'wamid.text-1',
        occurredAt: '2026-10-08T12:00:00.000Z',
        data: {
          channel: 'li_sales',
          channelId: 'SALES-7Q2',
          chatId: '491701234567@s.whatsapp.net',
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
    ]);
  });

  it('refuses a webhook whose secret is not the number’s own', async () => {
    const res = await whatsapp().inbound({
      headers: signedHeaders(support.webhookSecret),
      rawBody: webhook([textMessage]),
    });

    assert.equal(res.status, 401);
    assert.equal(res.problem?.type, 'urn:opsiforce:error:invalid-signature');
  });

  it('refuses a webhook with no secret header', async () => {
    const res = await whatsapp().inbound({
      headers: { 'content-type': 'application/json' },
      rawBody: webhook([textMessage]),
    });

    assert.equal(res.status, 401);
    assert.equal(res.problem?.type, 'urn:opsiforce:error:invalid-signature');
  });

  it('refuses a webhook for a channel that is not one of the numbers', async () => {
    const res = await whatsapp().inbound({
      headers: signedHeaders(),
      rawBody: webhook([textMessage], { channelId: 'UNKNOWN-1' }),
    });

    assert.equal(res.status, 401);
    assert.equal(res.problem?.type, 'urn:opsiforce:error:invalid-signature');
  });

  it('gives each message its own Event and skips entries without an id or chat', async () => {
    const group = { ...textMessage, id: 'wamid.text-2', chat_id: '120363000000000000@g.us', chat_name: 'Orders' };
    const res = await whatsapp().inbound({
      headers: signedHeaders(),
      rawBody: webhook([textMessage, { type: 'text' }, group]),
    });

    assert.deepEqual(
      res.body.events.map((event) => [event.key, event.data.chatId]),
      [
        ['wamid.text-1', '491701234567@s.whatsapp.net'],
        ['wamid.text-2', '120363000000000000@g.us'],
      ]
    );
  });

  it('answers a webhook with no messages with no Events', async () => {
    const res = await whatsapp().inbound({ headers: signedHeaders(), rawBody: webhook([]) });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.events, []);
  });

  it('stores a media message’s bytes, fetched with the number’s token, as the Event’s file', async () => {
    const photo = {
      ...textMessage,
      id: 'wamid.photo-1',
      type: 'image',
      text: undefined,
      image: { id: 'media-77', mime_type: 'image/jpeg', file_size: 5, caption: 'The pallet' },
    };
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/media/media-77`, new TextEncoder().encode('jpeg!'), {
      headers: { 'content-type': 'image/jpeg' },
    });

    const res = await service.inbound({ headers: signedHeaders(), rawBody: webhook([photo]) });

    const [event] = res.body.events;
    assert.equal(event?.data.text, 'The pallet');
    assert.equal(event?.data.caption, 'The pallet');
    assert.deepEqual(event?.data.media, { id: 'media-77', mimeType: 'image/jpeg', size: 5, stored: true });
    assert.deepEqual(
      event?.files?.map((file) => ({ ...file, bytes: new TextDecoder().decode(file.bytes) })),
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
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/media/media-88`, { error: 'gone' }, { status: 404 });
    service.upstream.reply('GET https://cdn.whapi.example.com/media-88', '%PDF-1.7');

    const res = await service.inbound({ headers: signedHeaders(), rawBody: webhook([document]) });

    const [event] = res.body.events;
    assert.deepEqual(event?.data.media, {
      id: 'media-88',
      mimeType: 'application/pdf',
      filename: 'order.pdf',
      stored: true,
    });
    assert.deepEqual(
      event?.files?.map((file) => file.name),
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
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/media/media-99`, { error: 'boom' }, { status: 500 });

    const res = await service.inbound({ headers: signedHeaders(), rawBody: webhook([voice]) });

    const [event] = res.body.events;
    assert.equal(res.status, 200);
    assert.deepEqual(event?.data.media, { id: 'media-99', mimeType: 'audio/ogg', size: 2048, stored: false });
    assert.equal(event?.files, undefined);
    assert.equal(event?.data.text, undefined);
  });

  it('stores what it fetched in time and marks the media that did not answer as not stored', async () => {
    const voiceOf = (id: string, mediaId: string) => ({
      ...textMessage,
      id,
      type: 'voice',
      text: undefined,
      voice: { id: mediaId, mime_type: 'audio/ogg', file_size: 5 },
    });
    const service = whatsapp();
    const never = () => new Promise(() => undefined);
    service.upstream.reply(`GET ${apiUrl}/media/media-slow-1`, never);
    service.upstream.reply(`GET ${apiUrl}/media/media-slow-2`, never);
    service.upstream.reply(`GET ${apiUrl}/media/media-fast`, new TextEncoder().encode('oggs!'), {
      headers: { 'content-type': 'audio/ogg' },
    });

    const res = await service.inbound({
      headers: signedHeaders(),
      rawBody: webhook([
        voiceOf('wamid.slow-1', 'media-slow-1'),
        voiceOf('wamid.slow-2', 'media-slow-2'),
        voiceOf('wamid.fast', 'media-fast'),
      ]),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.events.map((event) => [event.key, (event.data.media as { stored: boolean }).stored]),
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
    const service = whatsapp();
    service.upstream.reply(`GET ${apiUrl}/media/media-endless`, endless);

    const startedAt = Date.now();
    const res = await service.inbound({ headers: signedHeaders(), rawBody: webhook([video]) });

    const [event] = res.body.events;
    assert.equal(res.status, 200);
    assert.deepEqual(event?.data.media, { id: 'media-endless', mimeType: 'video/mp4', stored: false });
    assert.equal(event?.files, undefined);
    assert.ok(streamed <= limit + 8 * chunk.byteLength, `read ${streamed} bytes`);
    assert.ok(Date.now() - startedAt < 10_000, 'stopped before the media budget ran out');
  });
});
