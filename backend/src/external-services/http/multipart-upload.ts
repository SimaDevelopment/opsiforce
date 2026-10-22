import type { Multipart } from '@fastify/multipart';
import { PayloadTooLargeException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { JsonValue } from '../../common/json';

export interface UploadedFile {
  fieldName: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface MultipartUpload {
  fields: Record<string, string>;
  files: UploadedFile[];
}

const MEGABYTE = 1024 * 1024;
const PAYLOAD_TOO_LARGE = 413;
const OVERSIZED_PAYLOAD_MESSAGE = 'The upload exceeds the accepted size';

interface MultipartLimits {
  fieldNameSize: number;
  fieldSize: number;
  fields: number;
  fileSize: number;
  files: number;
  parts: number;
}

const MULTIPART_LIMITS: MultipartLimits = {
  fieldNameSize: 256,
  fieldSize: 25 * MEGABYTE,
  fields: 64,
  fileSize: 25 * MEGABYTE,
  files: 20,
  parts: 100,
};

const BUFFERED_BYTES_LIMIT = 30 * MEGABYTE;

export interface MultipartFastifyRequest extends FastifyRequest<{ Body: JsonValue }> {
  isMultipart(): boolean;
  parts(options?: { limits: MultipartLimits }): AsyncIterableIterator<Multipart>;
}

export async function parseMultipartUpload(req: MultipartFastifyRequest): Promise<MultipartUpload> {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  let bufferedBytes = 0;

  try {
    for await (const part of req.parts({ limits: MULTIPART_LIMITS })) {
      if (part.type === 'file') {
        const bytes = await part.toBuffer();

        bufferedBytes += bytes.byteLength;
        if (bufferedBytes > BUFFERED_BYTES_LIMIT) {
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
      if (bufferedBytes > BUFFERED_BYTES_LIMIT) {
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
