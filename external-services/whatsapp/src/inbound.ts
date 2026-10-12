import { ServiceError, type EventFile, type InboundHandler, type ServiceLog } from '@opsiforce/external-service-sdk';

import type { Manifest, Media, ReceivedMessage, ServiceConfiguration } from '../service.types.ts';
import { apiBaseOf, asText, errorText, sameText, webhookSecretHeader, type Channel } from './client.ts';

type RawObject = Record<string, unknown>;

interface FoundMedia {
  media: Media;
  caption?: string;
  link?: string;
}

const mediaTypes = new Set(['image', 'video', 'audio', 'voice', 'document', 'sticker', 'gif']);

const maxMediaBytes = 32 * 1024 * 1024;

const mediaBudgetMs = 20_000;

const fileExtensions: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
};

function asObject(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RawObject) : null;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function withoutUndefined<Shape extends object>(shape: Shape): Shape {
  return Object.fromEntries(Object.entries(shape).filter(([, value]) => value !== undefined)) as Shape;
}

function receivingChannel(configuration: ServiceConfiguration, channelId: string | undefined, secret: string) {
  if (!channelId || !secret) return undefined;
  return (configuration.channels ?? []).find((channel) => {
    const expected = channel.webhookSecret?.reveal();
    return channel.channelId === channelId && expected !== undefined && sameText(expected, secret);
  });
}

function mediaOf(message: RawObject, type: string): FoundMedia | undefined {
  const found = mediaTypes.has(type) ? asObject(message[type]) : null;
  const id = found ? asText(found.id) : undefined;
  if (!found || !id) return undefined;
  return withoutUndefined({
    media: withoutUndefined({
      id,
      mimeType: asText(found.mime_type),
      filename: asText(found.filename),
      size: asCount(found.file_size),
      stored: false,
    }),
    caption: asText(found.caption),
    link: asText(found.link),
  });
}

function joined(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxMediaBytes) {
    response.body?.cancel().catch(() => undefined);
    throw new Error(`declares ${declared} bytes`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return joined(chunks, received);
    received += value.byteLength;
    if (received > maxMediaBytes) {
      reader.cancel().catch(() => undefined);
      throw new Error(`is over ${maxMediaBytes} bytes`);
    }
    chunks.push(value);
  }
}

async function fetchedMedia(
  configuration: ServiceConfiguration,
  channel: Channel,
  found: FoundMedia,
  log: ServiceLog,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  const sources: [string, () => Promise<Response>][] = [
    [
      'the media endpoint',
      () =>
        fetch(`${apiBaseOf(configuration)}/media/${encodeURIComponent(found.media.id)}`, {
          headers: { authorization: `Bearer ${channel.apiToken.reveal()}` },
          signal,
        }),
    ],
  ];
  const { link } = found;
  if (link?.startsWith('https://')) {
    sources.push(['the media link', () => fetch(link, { signal })]);
  }
  const failures: string[] = [];
  for (const [source, fetchFrom] of sources) {
    if (signal.aborted) break;
    try {
      const response = await fetchFrom();
      if (!response.ok) throw new Error(`answered ${response.status}`);
      return await boundedBytes(response);
    } catch (error) {
      failures.push(`${source} ${errorText(error)}`);
    }
  }
  log.error('Could not fetch WhatsApp media; the Event keeps it as not stored', {
    mediaId: found.media.id,
    failures,
  });
  return null;
}

function fileNameOf(media: Media): string {
  if (media.filename) return media.filename;
  const extension = fileExtensions[(media.mimeType ?? '').split(';')[0]?.trim() ?? ''];
  return extension ? `${media.id}.${extension}` : media.id;
}

function sentAtOf(message: RawObject): string | undefined {
  const seconds = message.timestamp;
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

async function receivedMessage(
  configuration: ServiceConfiguration,
  channel: Channel,
  message: RawObject,
  log: ServiceLog,
  mediaSignal: AbortSignal
) {
  const messageId = asText(message.id);
  const chatId = asText(message.chat_id);
  if (!messageId || !chatId) return undefined;
  const type = asText(message.type) ?? 'unknown';
  const found = mediaOf(message, type);
  const bytes = found ? await fetchedMedia(configuration, channel, found, log, mediaSignal) : null;
  const sentAt = sentAtOf(message);
  const data: ReceivedMessage = withoutUndefined({
    channel: channel.id,
    channelId: channel.channelId,
    chatId,
    chatName: asText(message.chat_name),
    messageId,
    type,
    from: asText(message.from),
    fromName: asText(message.from_name),
    fromMe: message.from_me === true,
    text: asText(asObject(message.text)?.body) ?? found?.caption,
    caption: found?.caption,
    sentAt,
    source: asText(message.source),
    media: found ? { ...found.media, stored: bytes !== null } : undefined,
    message,
  });
  const files: EventFile[] =
    found && bytes
      ? [{ name: fileNameOf(found.media), mimeType: found.media.mimeType ?? 'application/octet-stream', bytes }]
      : [];
  return {
    type: 'message.received' as const,
    key: messageId,
    occurredAt: sentAt ?? new Date().toISOString(),
    data,
    ...(files.length > 0 ? { files } : {}),
  };
}

export const inbound: InboundHandler<Manifest> = async (request, ctx) => {
  const body = asObject(request.body);
  const channel = receivingChannel(
    ctx.serviceConfiguration,
    asText(body?.channel_id),
    request.headers[webhookSecretHeader.toLowerCase()] ?? ''
  );
  if (!channel) {
    throw new ServiceError({
      status: 401,
      code: 'invalid-signature',
      detail: `The channel_id or the ${webhookSecretHeader} header does not match a configured number.`,
    });
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const mediaSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(mediaBudgetMs)]);
  const received = await Promise.all(
    messages.map((entry) => {
      const message = asObject(entry);
      return message ? receivedMessage(ctx.serviceConfiguration, channel, message, ctx.log, mediaSignal) : undefined;
    })
  );
  return { events: received.filter((event) => event !== undefined) };
};
