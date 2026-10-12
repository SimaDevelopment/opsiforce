import { Transform, type Readable } from 'stream';
import { SERVICE_WEBHOOKS_PATH } from '../configuration/webhook-url';
import { routeBodyLimitHook } from './route-body-limit.hook';

export const WEBHOOK_ROUTE_PREFIX = `${SERVICE_WEBHOOKS_PATH}/`;

export const WEBHOOK_JSON_BODY_LIMIT = 5 * 1024 * 1024;

const MULTIPART_CONTENT_TYPE = 'multipart/form-data';

const capturedBodies = new WeakMap<object, Buffer[]>();

interface CapturedRequest {
  url: string;
  raw: object;
  headers: Record<string, string | string[] | undefined>;
}

function isMultipart(request: CapturedRequest): boolean {
  const contentType = request.headers['content-type'];
  return (Array.isArray(contentType) ? contentType[0] : contentType)?.includes(MULTIPART_CONTENT_TYPE) ?? false;
}

function captureRawBody(
  request: CapturedRequest,
  _reply: unknown,
  payload: Readable,
  done: (error: Error | null, stream?: Readable) => void
): void {
  if (!request.url.startsWith(WEBHOOK_ROUTE_PREFIX) || isMultipart(request)) return done(null, payload);

  const chunks: Buffer[] = [];
  capturedBodies.set(request.raw, chunks);
  const captured = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback(null, chunk);
    },
  });
  payload.on('error', (error) => captured.destroy(error));
  payload.pipe(captured);
  done(null, captured);
}

export function webhookPreParsingHooks() {
  return [routeBodyLimitHook(WEBHOOK_ROUTE_PREFIX, WEBHOOK_JSON_BODY_LIMIT), captureRawBody];
}

export function capturedRawBodyOf(request: { raw: object }): Buffer {
  return Buffer.concat(capturedBodies.get(request.raw) ?? []);
}
