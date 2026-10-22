import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { finished, pipeline, Readable, type Writable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
  type ZlibOptions,
} from 'node:zlib';

import type { Configurations, Upstream, UpstreamCredentials } from './define-service.ts';
import { sdkPackageVersion } from './package-version.ts';
import { Secret } from './secret.ts';

export interface UpstreamCall {
  upstream: Upstream<never>;
  method: string;
  origin: string;
  target: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | Uint8Array | null;
  signal?: AbortSignal;
}

export interface UpstreamTransport {
  readonly runsCredentials: boolean;
  send(call: UpstreamCall): Promise<Response>;
}

export class UpstreamAddressError extends Error {}

const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const callerCredentialHeaders = ['authorization', 'proxy-authorization', 'cookie', 'host'];

function connectionListed(headers: Headers): string[] {
  return (headers.get('connection') ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '');
}

export function withoutHopByHop(headers: Headers, options: { keepUpgrade?: boolean } = {}): Headers {
  const kept = new Headers(headers);
  const upgrade = headers.get('upgrade');
  for (const name of [...hopByHopHeaders, ...connectionListed(headers)]) kept.delete(name);
  if (options.keepUpgrade && upgrade !== null) {
    kept.set('connection', 'upgrade');
    kept.set('upgrade', upgrade);
  }
  return kept;
}

export function strippedCallerHeaders(headers: Headers, options: { keepUpgrade?: boolean } = {}): Headers {
  const kept = withoutHopByHop(headers, options);
  for (const name of callerCredentialHeaders) kept.delete(name);
  const opsiforceHeaders = Array.from(kept.keys()).filter((name) => name.startsWith('x-opsiforce-'));
  for (const name of opsiforceHeaders) kept.delete(name);
  return kept;
}

function revealed(value: string | Secret): string {
  return value instanceof Secret ? value.reveal() : String(value);
}

function withoutQueryKeys(rawQuery: string, keys: readonly string[]): string {
  if (rawQuery === '' || keys.length === 0) return rawQuery;
  return rawQuery
    .split('&')
    .filter((pair) => {
      const name = pair.split('=', 1)[0] ?? '';
      let decoded: string;
      try {
        decoded = decodeURIComponent(name.replaceAll('+', ' '));
      } catch {
        decoded = name;
      }
      return !keys.includes(decoded);
    })
    .join('&');
}

export interface UpstreamAddress {
  origin: string;
  basePath: string;
}

export function upstreamAddress(upstream: Upstream<never>, configurations: Configurations<never>): UpstreamAddress {
  const base = typeof upstream.url === 'function' ? upstream.url(configurations) : upstream.url;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new UpstreamAddressError(`upstream ${upstream.name}: url ${JSON.stringify(base)} is not an address`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamAddressError(`upstream ${upstream.name}: url must be http or https`);
  }
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
}

export function pathBelowMount(upstream: Upstream<never>, callerPath: string): string {
  const { mount } = upstream;
  if (mount === undefined) return callerPath;
  if (callerPath === mount) return '';
  if (callerPath.startsWith(`${mount}/`)) return callerPath.slice(mount.length);
  throw new UpstreamAddressError(`${callerPath} is outside upstream ${upstream.name}'s mount ${mount}`);
}

const defaultUserAgent = `opsiforce-external-service-sdk/${sdkPackageVersion}`;

export interface UpstreamCallPlan {
  upstream: Upstream<never>;
  configurations: Configurations<never>;
  method: string;
  path: string;
  rawQuery: string;
  headers: Headers;
  body: UpstreamCall['body'];
  signal?: AbortSignal;
}

export async function preparedUpstreamCall(plan: UpstreamCallPlan, runsCredentials: boolean): Promise<UpstreamCall> {
  const { origin, basePath } = upstreamAddress(plan.upstream, plan.configurations);
  const headers = new Headers(plan.headers);
  headers.set('host', new URL(origin).host);
  if (!headers.has('user-agent')) headers.set('user-agent', defaultUserAgent);
  const target = `${basePath}${plan.path}` || '/';
  let rawQuery = plan.rawQuery;

  const credentials: UpstreamCredentials =
    runsCredentials && plan.upstream.credentials
      ? await plan.upstream.credentials(plan.configurations, {
          method: plan.method,
          url: new URL(`${origin}${target}${rawQuery === '' ? '' : `?${rawQuery}`}`),
          headers: new Headers(headers),
        })
      : {};
  const query = Object.entries(credentials.query ?? {});
  rawQuery = withoutQueryKeys(
    rawQuery,
    query.map(([key]) => key)
  );
  const added = query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(revealed(value))}`);
  const fullQuery = [rawQuery, ...added].filter((part) => part !== '').join('&');
  for (const [name, value] of Object.entries(credentials.headers ?? {})) headers.set(name, revealed(value));

  return {
    upstream: plan.upstream,
    method: plan.method,
    origin,
    target: fullQuery === '' ? target : `${target}?${fullQuery}`,
    headers,
    body: plan.body,
    ...(plan.signal === undefined ? {} : { signal: plan.signal }),
  };
}

export function webStreamOf(
  readable: Readable,
  stopReading: (reason: unknown) => void = (reason) => readable.destroy(reason instanceof Error ? reason : undefined)
): ReadableStream<Uint8Array> {
  let settled = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        readable.pause();
        readable.on('data', (chunk: Uint8Array) => {
          if (settled) return;
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 0) <= 0) readable.pause();
        });
        finished(readable, (error) => {
          if (settled) return;
          settled = true;
          if (error) controller.error(error);
          else controller.close();
        });
      },
      pull() {
        readable.resume();
      },
      cancel(reason) {
        if (settled) return;
        settled = true;
        stopReading(reason);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: readable.readableHighWaterMark })
  );
}

export const nullBodyStatuses: ReadonlySet<number> = new Set([204, 205, 304]);

export function headersFromRaw(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    headers.append(rawHeaders[index] ?? '', rawHeaders[index + 1] ?? '');
  }
  return headers;
}

export function responseFromIncoming(incoming: IncomingMessage, method: string): Response {
  const status = incoming.statusCode ?? 502;
  const headers = withoutHopByHop(headersFromRaw(incoming.rawHeaders));
  if (nullBodyStatuses.has(status) || method === 'HEAD') {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  return new Response(webStreamOf(incoming), { status, headers });
}

export function headerRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers);
}

export function writeBody(body: UpstreamCall['body'], destination: Writable): void {
  if (body === null) {
    destination.end();
  } else if (body instanceof Uint8Array) {
    destination.end(body);
  } else {
    pipeline(Readable.fromWeb(body as NodeReadableStream<Uint8Array>), destination, (error) => {
      if (error) destination.destroy(error);
    });
  }
}

export function upstreamClientRequest(call: UpstreamCall) {
  const url = new URL(call.origin);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return send({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    method: call.method,
    path: call.target,
    headers: headerRecord(call.headers),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  });
}

export const nodeUpstreamTransport: UpstreamTransport = {
  runsCredentials: true,
  send(call) {
    return new Promise((resolve, reject) => {
      const outgoing = upstreamClientRequest(call);
      outgoing.on('response', (incoming) => {
        try {
          resolve(responseFromIncoming(incoming, call.method));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      outgoing.on('error', reject);
      writeBody(call.body, outgoing);
    });
  },
};

function encodingOf(headers: Headers): string {
  return (headers.get('content-encoding') ?? '').trim().toLowerCase();
}

export function decodedResponse(response: Response): Response {
  const encoding = encodingOf(response.headers);
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip()
      : encoding === 'deflate'
        ? createInflate()
        : encoding === 'br'
          ? createBrotliDecompress()
          : undefined;
  if (!decoder || response.body === null) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), decoder, () => undefined);
  return new Response(webStreamOf(decoder), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class DecodedBodyTooLarge extends Error {}

export function decodedBytes(raw: Uint8Array, headers: Headers, limit: number): Uint8Array {
  const encoding = encodingOf(headers);
  const options: ZlibOptions = { maxOutputLength: Math.max(limit, 1) };
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(raw, options);
    if (encoding === 'deflate') return inflateSync(raw, options);
    if (encoding === 'br') return brotliDecompressSync(raw, options);
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new DecodedBodyTooLarge();
    throw error;
  }
  return raw;
}
