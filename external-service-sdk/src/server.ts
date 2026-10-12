import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { problem, problemMediaType, type ProblemDetails } from './problems.ts';
import {
  createServiceRuntime,
  expectedManifestHeader,
  manifestHeader,
  ServiceBootError,
  serviceRoutes,
  type ServiceRoute,
  type ServiceRuntime,
  type ServiceRuntimeOptions,
} from './runtime.ts';
import { createFileServiceState } from './service-state.ts';

export {
  createServiceRuntime,
  expectedManifestHeader,
  formCallResultSchemas,
  formCallTimeoutSeconds,
  manifestHeader,
  maxOptionsPerCall,
  reloadingRetryAfterSeconds,
  ServiceBootError,
  serviceRoutes,
  wireContextSchema,
  type DispatchRequest,
  type HandlerNames,
  type ServiceHealth,
  type ServiceResponse,
  type ServiceRoute,
  type ServiceRuntime,
  type ServiceRuntimeOptions,
  type WireContext,
} from './runtime.ts';
export { computeManifestHash } from './manifest-hash.ts';
export { sdkPackageVersion } from './package-version.ts';
export {
  createFileServiceState,
  createMemoryServiceState,
  defaultStateFile,
  maxStateKeyLength,
  stateFileInWorkspace,
  unavailableServiceState,
} from './service-state.ts';
export type { AnyServiceHandlers } from './handlers.ts';

export const gatewayKeyHeader = 'x-opsiforce-gate';
export const maxRequestBytes = 48 * 1024 * 1024;

export interface ServiceServerOptions extends ServiceRuntimeOptions {
  gatewayKey?: string;
  stateFile?: string;
}

export interface ServiceServer {
  server: Server;
  runtime: ServiceRuntime;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function gatewayKeyMatches(presented: string | undefined, expected: string): boolean {
  return timingSafeEqual(digest(presented ?? ''), digest(expected)) && presented !== undefined && presented !== '';
}

class RequestTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxRequestBytes) throw new RequestTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function callIdOf(body: unknown): string | undefined {
  const context = (body as { context?: { callId?: unknown } } | null)?.context;
  return typeof context?.callId === 'string' ? context.callId : undefined;
}

function routeOf(method: string, pathname: string): { route: ServiceRoute | 'health'; name?: string } | undefined {
  if (pathname === '/_service/health') return method === 'GET' ? { route: 'health' } : undefined;
  if (method !== 'POST') return undefined;
  if (pathname === '/_service/inbound') return { route: 'inbound' };
  const match = /^\/_service\/([a-z]+)\/([^/]+)$/.exec(pathname);
  const [, route, name] = match ?? [];
  if (!route || !name || route === 'inbound' || !(serviceRoutes as readonly string[]).includes(route)) {
    return undefined;
  }
  return { route: route as ServiceRoute, name: decodeURIComponent(name) };
}

export function createServiceServer(options: ServiceServerOptions): ServiceServer {
  const gatewayKey = options.gatewayKey ?? process.env.SERVICE_GATEWAY_API_KEY ?? '';
  if (gatewayKey === '') {
    throw new ServiceBootError('The service cannot start: SERVICE_GATEWAY_API_KEY is not set');
  }
  const state = createFileServiceState(options.stateFile);
  const runtime = createServiceRuntime({ ...options, state: options.state ?? (() => state) });
  const stamp = { [manifestHeader]: runtime.manifestHash };

  const send = (response: ServerResponse, status: number, headers: Record<string, string>, body: Uint8Array) => {
    response.writeHead(status, { ...headers, ...stamp, 'content-length': String(body.byteLength) });
    response.end(body);
  };
  const sendProblem = (response: ServerResponse, body: ProblemDetails) =>
    send(response, body.status, { 'content-type': problemMediaType }, Buffer.from(JSON.stringify(body)));

  const handle = async (request: IncomingMessage, response: ServerResponse, seen: { callId?: string }) => {
    const presented = request.headers[gatewayKeyHeader];
    if (!gatewayKeyMatches(Array.isArray(presented) ? presented[0] : presented, gatewayKey)) {
      request.resume();
      return sendProblem(
        response,
        problem({ status: 401, code: 'unauthorized', detail: `Missing or wrong ${gatewayKeyHeader}.` })
      );
    }

    const url = new URL(request.url ?? '/', 'http://service.local');
    const target = routeOf(request.method ?? 'GET', url.pathname);
    if (!target) {
      request.resume();
      return sendProblem(
        response,
        problem({ status: 404, code: 'unknown-route', detail: `No route ${url.pathname}.` })
      );
    }
    if (target.route === 'health') {
      return send(response, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(runtime.health())));
    }

    let raw: Buffer;
    try {
      raw = await readBody(request);
    } catch (error) {
      if (error instanceof RequestTooLarge) {
        return sendProblem(
          response,
          problem({ status: 413, code: 'request-too-large', detail: `Requests are at most ${maxRequestBytes} bytes.` })
        );
      }
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendProblem(response, problem({ status: 400, code: 'invalid-request', detail: 'The body is not JSON.' }));
    }
    seen.callId = callIdOf(body);

    const aborted = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborted.abort();
    });
    const expected = request.headers[expectedManifestHeader];
    const answer = await runtime.dispatch({
      route: target.route,
      name: target.name,
      body,
      signal: aborted.signal,
      expectedManifestHash: Array.isArray(expected) ? expected[0] : expected,
    });
    if (!response.destroyed) send(response, answer.status, answer.headers, answer.body);
  };

  const server = createServer((request, response) => {
    const seen: { callId?: string } = {};
    handle(request, response, seen).catch(() => {
      if (!response.headersSent) {
        sendProblem(
          response,
          problem({ status: 502, code: 'service-failed', detail: 'The service failed.', callId: seen.callId })
        );
      } else {
        response.destroy();
      }
    });
  });

  return { server, runtime };
}
