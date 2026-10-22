import { createHmac, timingSafeEqual } from 'node:crypto';

import type { DeliveredEventFile, WebhookHandler } from '@opsiforce/external-service-sdk';

import type { Manifest } from '../service.types.ts';

const signatureWindowSeconds = 300;

const attachmentFieldPrefix = 'attachment-';

const megabyte = 1024 * 1024;

const defaultMaxAttachmentMb = 25;

interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
}

interface Header {
  name: string;
  value: string;
}

interface AttachedFile {
  field: string;
  file: File;
}

interface Forward {
  fields: Record<string, string>;
  files: AttachedFile[];
}

class RefusedSignature extends Error {}

async function forwardOf(request: Request): Promise<Forward> {
  const fields: Record<string, string> = {};
  const files: AttachedFile[] = [];
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { fields, files };
  }
  for (const [field, value] of form.entries()) {
    if (typeof value === 'string') fields[field] = value;
    else files.push({ field, file: value });
  }
  return { fields, files };
}

function sameHex(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function verifiedSignatureTime(fields: Record<string, string>, signingKey: string): number {
  const { timestamp, token, signature } = fields;
  if (!timestamp || !token || !signature) throw new RefusedSignature('The Mailgun signature fields are missing.');

  const signedAtSeconds = Number(timestamp);
  if (!Number.isFinite(signedAtSeconds) || Math.abs(Date.now() / 1000 - signedAtSeconds) > signatureWindowSeconds) {
    throw new RefusedSignature('The Mailgun signature timestamp is outside the accepted window.');
  }

  const expected = createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');
  if (!sameHex(expected, signature))
    throw new RefusedSignature('The Mailgun signature does not match the signing key.');
  return signedAtSeconds;
}

function headersOf(fields: Record<string, string>): Header[] {
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

function messageIdOf(fields: Record<string, string>, headers: Header[]): string | undefined {
  const field = fields['Message-Id'] || fields['message-id'];
  if (field) return field;
  return headers.find((header) => header.name.toLowerCase() === 'message-id')?.value;
}

function recipientsOf(fields: Record<string, string>): string[] {
  return (fields.recipient ?? '')
    .split(',')
    .map((recipient) => recipient.trim().toLowerCase())
    .filter((recipient) => recipient.includes('@'));
}

function describedAttachment({ file }: AttachedFile): Attachment {
  return { filename: file.name, mimeType: file.type, size: file.size };
}

async function eventFileOf({ file }: AttachedFile): Promise<DeliveredEventFile> {
  return { name: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function optional<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value ? ({ [key]: value } as Record<Key, string>) : {};
}

function refusal(message: string): Response {
  return Response.json({ message }, { status: 401 });
}

export const webhook: WebhookHandler<Manifest> = async (request, ctx) => {
  const { signingKey } = ctx.serviceConfiguration;
  if (!signingKey) {
    return Response.json(
      { message: 'Incoming email is not set up on this deployment yet.' },
      { status: 503, headers: { 'retry-after': '300' } }
    );
  }
  const { fields, files } = await forwardOf(request);
  let signedAtSeconds: number;
  try {
    signedAtSeconds = verifiedSignatureTime(fields, signingKey.reveal());
  } catch (error) {
    if (error instanceof RefusedSignature) return refusal(error.message);
    throw error;
  }

  const maxAttachmentBytes = (ctx.serviceConfiguration.maxAttachmentMb ?? defaultMaxAttachmentMb) * megabyte;
  const attached = files.filter((entry) => entry.field.startsWith(attachmentFieldPrefix));
  const stored = attached.filter((entry) => entry.file.size <= maxAttachmentBytes);
  const omitted = attached.filter((entry) => entry.file.size > maxAttachmentBytes);
  if (omitted.length > 0) ctx.note({ omittedAttachments: omitted.length });

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
  const eventFiles = await Promise.all(stored.map(eventFileOf));

  const configurations = await ctx.service.projectConfigurations();
  let unmatched = 0;
  for (const recipient of recipientsOf(fields)) {
    const address = recipient.slice(0, recipient.lastIndexOf('@'));
    const to = configurations
      .filter((entry) => entry.projectConfiguration.localPart?.toLowerCase() === address)
      .map((entry) => entry.projectEnvironmentId);
    if (to.length === 0) {
      unmatched++;
      continue;
    }
    await ctx.service.deliver(
      {
        type: 'email.received',
        key: messageId ?? fields.token ?? '',
        occurredAt: new Date(signedAtSeconds * 1000).toISOString(),
        data: { address, recipient, ...email },
        files: eventFiles,
      },
      { to }
    );
  }
  if (unmatched > 0) ctx.note({ unmatchedRecipients: unmatched });
  return undefined;
};
