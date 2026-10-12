import { Transform } from 'stream';
import type { Readable } from 'stream';

const MULTIPART_CONTENT_TYPE = 'multipart/form-data';

interface BodyLimitRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

function headerValue(headers: BodyLimitRequest['headers'], name: string): string {
  const raw = headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return '';
}

function payloadTooLarge(maxBytes: number): Error & { statusCode?: number } {
  const error: Error & { statusCode?: number } = new Error(
    `The payload exceeds the ${maxBytes} byte limit for this route`
  );
  error.statusCode = 413;
  return error;
}

export function routeBodyLimitHook(routePrefix: string, maxBytes: number) {
  return function limitRouteBody(
    request: BodyLimitRequest,
    _reply: unknown,
    payload: Readable,
    done: (error: Error | null, stream?: Readable) => void
  ): void {
    if (!request.url.startsWith(routePrefix)) return done(null, payload);
    if (headerValue(request.headers, 'content-type').includes(MULTIPART_CONTENT_TYPE)) return done(null, payload);

    const declared = Number(headerValue(request.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return done(payloadTooLarge(maxBytes));

    let received = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(payloadTooLarge(maxBytes));
          return;
        }
        callback(null, chunk);
      },
    });

    payload.on('error', (error) => counted.destroy(error));
    payload.pipe(counted);

    done(null, counted);
  };
}
