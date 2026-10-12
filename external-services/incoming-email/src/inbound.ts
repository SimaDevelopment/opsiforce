import { createHmac, timingSafeEqual } from 'node:crypto';

import { ServiceError, type InboundFile, type InboundHandler } from '@opsiforce/external-service-sdk';

import type { Attachment, Manifest, ReceivedEmail } from '../service.types.ts';

const signatureWindowSeconds = 300;

const attachmentFieldPrefix = 'attachment-';

const megabyte = 1024 * 1024;

const defaultMaxAttachmentMb = 25;

type Fields = Record<string, string>;

function fieldsOf(body: unknown): Fields {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const fields: Fields = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') fields[name] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') fields[name] = String(value);
  }
  return fields;
}

function refusedSignature(detail: string): ServiceError {
  return new ServiceError({ status: 401, code: 'invalid-signature', detail });
}

function sameHex(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function verifySignature(fields: Fields, signingKey: string): number {
  const { timestamp, token, signature } = fields;
  if (!timestamp || !token || !signature) throw refusedSignature('The Mailgun signature fields are missing.');

  const signedAtSeconds = Number(timestamp);
  if (!Number.isFinite(signedAtSeconds) || Math.abs(Date.now() / 1000 - signedAtSeconds) > signatureWindowSeconds) {
    throw refusedSignature('The Mailgun signature timestamp is outside the accepted window.');
  }

  const expected = createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');
  if (!sameHex(expected, signature)) throw refusedSignature('The Mailgun signature does not match the signing key.');
  return signedAtSeconds;
}

function headersOf(fields: Fields): ReceivedEmail['headers'] {
  const raw = fields['message-headers'];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) =>
    Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      ? [{ name: entry[0], value: entry[1] }]
      : []
  );
}

function messageIdOf(fields: Fields, headers: ReceivedEmail['headers']): string | undefined {
  const field = fields['Message-Id'] || fields['message-id'];
  if (field) return field;
  return headers.find((header) => header.name.toLowerCase() === 'message-id')?.value;
}

function recipientsOf(fields: Fields): string[] {
  return (fields.recipient ?? '')
    .split(',')
    .map((recipient) => recipient.trim().toLowerCase())
    .filter((recipient) => recipient.includes('@'));
}

function describedAttachment(file: InboundFile): Attachment {
  return { filename: file.filename, mimeType: file.mimeType, size: file.bytes.byteLength };
}

function optional<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value ? ({ [key]: value } as Record<Key, string>) : {};
}

export const inbound: InboundHandler<Manifest> = (request, ctx) => {
  const fields = fieldsOf(request.body);
  const signedAtSeconds = verifySignature(fields, ctx.serviceConfiguration.signingKey.reveal());

  const maxAttachmentBytes = (ctx.serviceConfiguration.maxAttachmentMb ?? defaultMaxAttachmentMb) * megabyte;
  const attachedFiles = request.files.filter((file) => (file.field ?? '').startsWith(attachmentFieldPrefix));
  const stored = attachedFiles.filter((file) => file.bytes.byteLength <= maxAttachmentBytes);
  const omitted = attachedFiles.filter((file) => file.bytes.byteLength > maxAttachmentBytes);

  const headers = headersOf(fields);
  const messageId = messageIdOf(fields, headers);
  const email = {
    from: fields.sender ?? '',
    ...optional('fromHeader', fields.from),
    subject: fields.subject ?? '',
    text: fields['stripped-text'] ?? fields['body-plain'] ?? '',
    ...optional('bodyPlain', fields['body-plain']),
    ...optional('bodyHtml', fields['body-html']),
    ...optional('messageId', messageId),
    headers,
    attachments: stored.map(describedAttachment),
    omittedAttachments: omitted.map(describedAttachment),
  };

  const events = recipientsOf(fields).map((recipient) => ({
    type: 'email.received' as const,
    key: messageId ?? fields.token ?? '',
    occurredAt: new Date(signedAtSeconds * 1000).toISOString(),
    data: { address: recipient.slice(0, recipient.lastIndexOf('@')), recipient, ...email },
    files: stored.map((file) => ({ name: file.filename, mimeType: file.mimeType, bytes: file.bytes })),
  }));
  if (omitted.length > 0) {
    ctx.log.warn('Left out attachments over the size limit', {
      omitted: omitted.length,
      maxAttachmentMb: maxAttachmentBytes / megabyte,
    });
  }
  return { events };
};
