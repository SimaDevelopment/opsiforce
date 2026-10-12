import { Readable } from 'stream';
import type { Multipart } from '@fastify/multipart';
import { PayloadTooLargeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { JsonValue } from '../../common/json';
import type { InboundRequest } from '../inbound/inbound-request';
import { capturedRawBodyOf } from './webhook-routes';

export interface WebhookFile {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface MultipartWebhook {
  fields: Record<string, string>;
  files: WebhookFile[];
}

const MEGABYTE = 1024 * 1024;
const PAYLOAD_TOO_LARGE = 413;
const OVERSIZED_PAYLOAD_MESSAGE = 'Webhook payload exceeds the accepted size';

interface MultipartLimits {
  fieldNameSize: number;
  fieldSize: number;
  fields: number;
  fileSize: number;
  files: number;
  parts: number;
}

const WEBHOOK_MULTIPART_LIMITS: MultipartLimits = {
  fieldNameSize: 256,
  fieldSize: 25 * MEGABYTE,
  fields: 64,
  fileSize: 25 * MEGABYTE,
  files: 20,
  parts: 100,
};

const WEBHOOK_BUFFERED_BYTES_LIMIT = 30 * MEGABYTE;

export interface WebhookFastifyRequest extends FastifyRequest<{ Body: JsonValue }> {
  isMultipart(): boolean;
  parts(options?: { limits: MultipartLimits }): AsyncIterableIterator<Multipart>;
}

export async function parseMultipartWebhook(req: WebhookFastifyRequest): Promise<MultipartWebhook> {
  const fields: Record<string, string> = {};
  const files: WebhookFile[] = [];
  let bufferedBytes = 0;

  try {
    for await (const part of req.parts({ limits: WEBHOOK_MULTIPART_LIMITS })) {
      if (part.type === 'file') {
        const bytes = await part.toBuffer();

        bufferedBytes += bytes.byteLength;
        if (bufferedBytes > WEBHOOK_BUFFERED_BYTES_LIMIT) {
          throw new PayloadTooLargeException(OVERSIZED_PAYLOAD_MESSAGE);
        }

        files.push({
          fieldName: part.fieldname,
          filename: part.filename,
          contentType: part.mimetype,
          bytes,
        });
        continue;
      }

      if (part.valueTruncated) throw new PayloadTooLargeException(OVERSIZED_PAYLOAD_MESSAGE);

      const value = String(part.value);

      bufferedBytes += Buffer.byteLength(value);
      if (bufferedBytes > WEBHOOK_BUFFERED_BYTES_LIMIT) {
        throw new PayloadTooLargeException(OVERSIZED_PAYLOAD_MESSAGE);
      }

      fields[part.fieldname] = value;
    }
  } catch (error) {
    if (exceedsMultipartLimit(error)) throw new PayloadTooLargeException(OVERSIZED_PAYLOAD_MESSAGE);
    throw error;
  }

  return { fields, files };
}

function exceedsMultipartLimit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as { statusCode?: unknown };
  return candidate.statusCode === PAYLOAD_TOO_LARGE;
}

export function headersOf(req: WebhookFastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(', ');
  }
  return headers;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 413) {
      throw new PayloadTooLargeException((error as Error).message);
    }
    throw error;
  }
  return Buffer.concat(chunks);
}

function queryOf(req: WebhookFastifyRequest): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries((req.query ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') query[name] = value;
    else if (Array.isArray(value)) query[name] = value.map(String);
  }
  return query;
}

export async function inboundRequestOf(req: WebhookFastifyRequest): Promise<InboundRequest> {
  const base = { method: req.method, headers: headersOf(req), query: queryOf(req) };
  if (req.isMultipart()) {
    const parsed = await parseMultipartWebhook(req);
    const files = parsed.files.map((file) => ({
      field: file.fieldName,
      filename: file.filename,
      mimeType: file.contentType,
      bytes: new Uint8Array(file.bytes),
    }));
    const bytes =
      Object.values(parsed.fields).reduce((total, value) => total + Buffer.byteLength(value), 0) +
      files.reduce((total, file) => total + file.bytes.byteLength, 0);
    return { ...base, rawBody: new Uint8Array(), fields: parsed.fields, files, bytes };
  }

  const rawBody = req.body instanceof Readable ? await readStream(req.body) : capturedRawBodyOf(req);
  return { ...base, rawBody: new Uint8Array(rawBody), files: [], bytes: rawBody.byteLength };
}
