import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { DefinedService, ServiceHandle } from './define-service.ts';
import { failureMessages, refusalOf, refusalResponse } from './refusals.ts';
import {
  createServicePipeline,
  type ConfigurationSource,
  type EventDelivery,
  type IncomingCall,
  type ServiceRecords,
} from './service-pipeline.ts';
import { gatewayConfigurations } from './gateway-configurations.ts';
import { gatewayEvents } from './gateway-events.ts';
import { createFileServiceRecords } from './service-records.ts';
import { createFileServiceState, withAtomicUpdate } from './service-state.ts';
import {
  headersFromRaw,
  nodeUpstreamTransport,
  upstreamClientRequest,
  webStreamOf,
  withoutHopByHop,
  type UpstreamTransport,
} from './upstream-forwarding.ts';

export interface ServiceHttpServerOptions {
  gatewayKey?: string;
  gatewayUrl?: string;
  stateFile?: string;
  recordsFile?: string;
  configurations?: ConfigurationSource;
  upstreams?: UpstreamTransport;
  records?: ServiceRecords;
  events?: EventDelivery;
  webhookUrl?: string;
}

export const idleConnectionTimeoutMs = 75_000;

export interface ServiceHttpServer {
  server: Server;
  service: ServiceHandle;
}

export class ServiceStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceStartError';
  }
}

export const configurationsNotAvailable: ConfigurationSource = {
  forCaller: () => Promise.reject(new Error('the configuration fetch is not available in this runtime yet')),
  service: () => Promise.reject(new Error('the configuration fetch is not available in this runtime yet')),
  projectConfigurations: () =>
    Promise.reject(new Error('the configuration fetch is not available in this runtime yet')),
};

function hasBody(request: IncomingMessage): boolean {
  const length = request.headers['content-length'];
  return request.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

function incomingCall(request: IncomingMessage, signal?: AbortSignal): IncomingCall {
  const body = hasBody(request) ? webStreamOf(request, () => request.resume()) : null;
  if (body === null) request.resume();
  return {
    method: request.method ?? 'GET',
    target: request.url ?? '/',
    headers: headersFromRaw(request.rawHeaders),
    body,
    ...(signal === undefined ? {} : { signal }),
  };
}

function flatHeaders(headers: Headers): string[] {
  const flat: string[] = [];
  for (const [name, value] of headers) {
    if (name !== 'set-cookie') flat.push(name, value);
  }
  for (const cookie of headers.getSetCookie()) flat.push('set-cookie', cookie);
  return flat;
}

async function writeAnswer(response: ServerResponse, answer: Response): Promise<void> {
  response.writeHead(answer.status, answer.statusText || undefined, flatHeaders(answer.headers));
  if (answer.body === null) {
    response.end();
    return;
  }
  response.flushHeaders();
  await pipeline(answer.body, response);
}

function rawHead(status: number, statusText: string, headers: Headers): string {
  const lines = [`HTTP/1.1 ${status} ${statusText}`];
  for (let index = 0, flat = flatHeaders(headers); index + 1 < flat.length; index += 2) {
    lines.push(`${flat[index]}: ${flat[index + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

async function writeRawAnswer(socket: Duplex, answer: Response): Promise<void> {
  const bytes = new Uint8Array(await answer.arrayBuffer());
  const headers = withoutHopByHop(answer.headers);
  headers.set('content-length', String(bytes.byteLength));
  headers.set('connection', 'close');
  socket.end(Buffer.concat([Buffer.from(rawHead(answer.status, answer.statusText, headers)), bytes]));
}

export function createServiceHttpServer(
  defined: DefinedService,
  options: ServiceHttpServerOptions = {}
): ServiceHttpServer {
  const gatewayKey = options.gatewayKey ?? process.env.SERVICE_GATEWAY_API_KEY ?? '';
  if (gatewayKey === '') throw new ServiceStartError('The service cannot start: SERVICE_GATEWAY_API_KEY is not set');
  const gatewayUrl = options.gatewayUrl ?? process.env.SERVICE_GATEWAY_URL ?? '';
  const fileRecords = createFileServiceRecords(options.recordsFile === undefined ? {} : { file: options.recordsFile });
  const pipeline = createServicePipeline(defined, {
    gatewayKey,
    configurations:
      options.configurations ??
      (gatewayUrl === '' ? configurationsNotAvailable : gatewayConfigurations({ url: gatewayUrl, gatewayKey })),
    upstreams: options.upstreams ?? nodeUpstreamTransport,
    state: withAtomicUpdate(createFileServiceState(options.stateFile)),
    records: options.records ?? fileRecords,
    ...(options.events !== undefined
      ? { events: options.events }
      : gatewayUrl === ''
        ? {}
        : { events: gatewayEvents({ url: gatewayUrl, gatewayKey }) }),
    webhookUrl: options.webhookUrl ?? process.env.SERVICE_WEBHOOK_URL ?? '',
  });
  const failedAnswer = (kind: 'failed' | 'upstreamUnreachable') =>
    refusalResponse(
      refusalOf('failed', failureMessages[kind](defined.manifest.displayName)),
      new Request('http://service.local/'),
      defined.definition.refusal
    );

  const server = createServer((request, response) => {
    const aborted = new AbortController();
    response.on('close', () => {
      if (!response.writableFinished) aborted.abort();
    });
    pipeline
      .answer(incomingCall(request, aborted.signal))
      .then((answer) => writeAnswer(response, answer))
      .catch(async () => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        await writeAnswer(response, await failedAnswer('failed'));
      })
      .catch(() => response.destroy());
  });
  server.requestTimeout = 0;
  server.keepAliveTimeout = idleConnectionTimeoutMs;
  server.headersTimeout = idleConnectionTimeoutMs + 1000;

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    void (async () => {
      const decision = await pipeline.answerUpgrade(incomingCall(request));
      if (decision instanceof Response) {
        await writeRawAnswer(socket, decision);
        return;
      }
      const outgoing = upstreamClientRequest(decision);
      outgoing.on('upgrade', (upstreamAnswer, upstreamSocket, upstreamHead) => {
        socket.write(
          rawHead(101, upstreamAnswer.statusMessage ?? 'Switching Protocols', headersFromRaw(upstreamAnswer.rawHeaders))
        );
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.on('error', () => socket.destroy());
        socket.on('close', () => upstreamSocket.destroy());
        upstreamSocket.on('close', () => socket.destroy());
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      outgoing.on('response', (upstreamAnswer) => {
        const headers = withoutHopByHop(headersFromRaw(upstreamAnswer.rawHeaders));
        headers.delete('content-length');
        headers.set('connection', 'close');
        socket.write(rawHead(upstreamAnswer.statusCode ?? 502, upstreamAnswer.statusMessage ?? '', headers));
        upstreamAnswer.pipe(socket);
      });
      outgoing.on('error', () => {
        void failedAnswer('upstreamUnreachable').then((answer) => writeRawAnswer(socket, answer));
      });
      outgoing.end();
    })().catch(() => socket.destroy());
  });

  server.on('close', () => fileRecords.close());

  return { server, service: pipeline.service };
}
