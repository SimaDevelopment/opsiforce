import { request, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

export interface PodRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export function fetchAsLocalhost(url: URL, init: PodRequestInit = {}): Promise<Response> {
  const { signal } = init;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let incoming: IncomingMessage | undefined;
    const outgoing = request(
      url,
      { method: init.method ?? 'GET', headers: { ...init.headers, host: `localhost:${url.port}` } },
      (response) => {
        incoming = response;
        const status = response.statusCode ?? 502;
        const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
        if (body === null) response.resume();
        resolve(new Response(body, { status, statusText: response.statusMessage, headers: headersOf(response) }));
      }
    );
    const abort = () => (incoming ?? outgoing).destroy(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    outgoing.once('close', () => signal?.removeEventListener('abort', abort));
    outgoing.on('error', reject);
    outgoing.end(init.body);
  });
}

function headersOf(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
  }
  return headers;
}
