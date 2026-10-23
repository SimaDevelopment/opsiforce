import { request, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

export interface PodRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual';
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
]);
const MAX_REDIRECTS = 20;

export async function fetchAsLocalhost(url: URL, init: PodRequestInit = {}): Promise<Response> {
  let target = url;
  let current = init;
  for (let redirects = 0; ; redirects += 1) {
    const response = await send(target, current);
    const next =
      current.redirect === 'manual' || redirects === MAX_REDIRECTS ? null : sameAppRedirect(target, response);
    if (!next) return response;
    await response.body?.cancel();
    current = redirectedInit(current, response.status);
    target = next;
  }
}

function sameAppRedirect(target: URL, response: Response): URL | null {
  const location = response.headers.get('location');
  if (!REDIRECT_STATUSES.has(response.status) || !location) return null;
  const presented = new URL(`${target.pathname}${target.search}`, `http://localhost:${target.port}`);
  const next = new URL(location, presented);
  if (next.origin !== presented.origin && next.origin !== target.origin) return null;
  return new URL(`${next.pathname}${next.search}`, target);
}

function redirectedInit(init: PodRequestInit, status: number): PodRequestInit {
  const method = init.method ?? 'GET';
  const becomesGet = status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST';
  if (!becomesGet) return init;
  return { ...init, method: 'GET', body: undefined, headers: withoutBodyHeaders(init.headers) };
}

function withoutBodyHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
}

function send(url: URL, init: PodRequestInit): Promise<Response> {
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
        try {
          const status = response.statusCode ?? 502;
          const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
          if (body === null) response.resume();
          resolve(new Response(body, { status, statusText: response.statusMessage, headers: headersOf(response) }));
        } catch (error) {
          response.destroy();
          reject(error);
        }
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
