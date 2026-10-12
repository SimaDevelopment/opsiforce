import type { EventToStore, LegacyMessage, LegacyMessageOf } from '../inbound/external-service-store';
import type { RegisteredService } from '../registry/service-registry';

interface EmailHeader {
  name: string;
  value: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function emailHeaders(value: unknown): EmailHeader[] {
  return Array.isArray(value) ? (value as EmailHeader[]) : [];
}

function incomingEmailMessage(event: EventToStore): LegacyMessage {
  const { data } = event;
  return {
    providerMessageId: event.key,
    rawPayload: JSON.stringify(data),
    routingKey: String(data.recipient),
    sender: text(data.from),
    textBody: text(data.text),
    payload: {
      from_header: text(data.fromHeader),
      subject: text(data.subject),
      body_plain: text(data.bodyPlain),
      body_html: text(data.bodyHtml),
      message_headers: JSON.stringify(emailHeaders(data.headers).map((header) => [header.name, header.value])),
    },
    attachments: event.files.map((file) => ({
      filename: file.name,
      contentType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
      content: Buffer.from(file.bytes),
    })),
  };
}

interface WhatsappMedia {
  id: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  stored: boolean;
}

function whatsappMedia(value: unknown): WhatsappMedia | null {
  return typeof value === 'object' && value !== null ? (value as WhatsappMedia) : null;
}

function whatsappMessage(event: EventToStore): LegacyMessage {
  const { data } = event;
  const media = whatsappMedia(data.media);
  const [file] = event.files;
  return {
    providerMessageId: event.key,
    rawPayload: JSON.stringify(data.message ?? data),
    routingKey: String(data.chatId),
    sender: text(data.from),
    textBody: text(data.text),
    payload: {
      channel_id: text(data.channelId),
      chat_name: text(data.chatName),
      from_me: data.fromMe === true,
      from_name: text(data.fromName),
      type: text(data.type),
      sent_at: text(data.sentAt),
      source: text(data.source),
      caption: text(data.caption),
      media_id: media?.id ?? null,
      media_fetch_failed: media !== null && !media.stored,
    },
    attachments: media
      ? [
          {
            filename: media.filename ?? null,
            contentType: media.mimeType ?? null,
            sizeBytes: file?.bytes.byteLength ?? media.size ?? 0,
            content: file ? Buffer.from(file.bytes) : null,
          },
        ]
      : [],
  };
}

const legacyMessageMappers: Record<string, LegacyMessageOf> = {
  'incoming-email': incomingEmailMessage,
  whatsapp: whatsappMessage,
};

export function legacyMessageOf(service: RegisteredService): LegacyMessageOf | undefined {
  return service.origin === 'built_in' ? legacyMessageMappers[service.slug] : undefined;
}
