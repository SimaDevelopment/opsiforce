import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineHandlers, ServiceError } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

interface ProviderEvent {
  type: string;
  key: string;
  occurredAt: string;
  data: Record<string, unknown>;
  files?: { name: string; mimeType: string; text: string; repeat?: number }[];
  withUploads?: boolean;
}

interface ProviderPayload {
  events?: ProviderEvent[];
  challenge?: string;
  leak?: boolean;
  answer?: { status?: number; headers?: Record<string, string>; body?: unknown };
}

const encoder = new TextEncoder();

function signedBytes(rawBody: Uint8Array, body: unknown): Uint8Array {
  if (rawBody.byteLength > 0) return rawBody;
  const payload = (body as { payload?: unknown } | undefined)?.payload;
  return encoder.encode(typeof payload === 'string' ? payload : '');
}

function payloadOf(rawBody: Uint8Array, body: unknown): ProviderPayload {
  if (rawBody.byteLength > 0) return body as ProviderPayload;
  const payload = (body as { payload?: unknown } | undefined)?.payload;
  return typeof payload === 'string' ? (JSON.parse(payload) as ProviderPayload) : {};
}

export default defineHandlers<Manifest>({
  manifestHash,
  inbound: (request, ctx) => {
    const expected = createHmac('sha256', ctx.serviceConfiguration.signingKey.reveal())
      .update(signedBytes(request.rawBody, request.body))
      .digest();
    const presented = Buffer.from(request.headers['x-fixture-signature'] ?? '', 'hex');
    if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
      throw new ServiceError({ status: 401, code: 'bad-signature', detail: 'The signature does not match.' });
    }

    const payload = payloadOf(request.rawBody, request.body);
    if (payload.answer !== undefined) return { events: [], response: payload.answer };
    if (payload.challenge !== undefined) {
      return { events: [], response: { status: 200, body: { challenge: payload.challenge } } };
    }
    const leaked = payload.leak ? { signingKey: ctx.serviceConfiguration.signingKey.reveal() } : {};
    const events = (payload.events ?? []).map((event) => ({
      type: event.type,
      key: event.key,
      occurredAt: event.occurredAt,
      data: { ...event.data, ...leaked },
      files: [
        ...(event.files ?? []).map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          bytes: encoder.encode(file.text.repeat(file.repeat ?? 1)),
        })),
        ...(event.withUploads
          ? request.files.map((file) => ({ name: file.filename, mimeType: file.mimeType, bytes: file.bytes }))
          : []),
      ],
    }));
    return { events } as never;
  },
});
