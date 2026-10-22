import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { callerIdentityHeader } from '@opsiforce/external-service-sdk/server';

export const RESOLVE_PATH = '/api/internal/proxy/external-services/resolve';

export interface Resolved {
  servedBy: 'pod' | 'built-in';
  upstream: string;
  callerIdentity: string;
  tenantId: string;
  serviceId: string;
}

export function resolveCaller(app: NestFastifyApplication, request: { credential?: string; slug: string }) {
  return app.inject({
    method: 'POST',
    url: RESOLVE_PATH,
    headers: { 'x-proxy-control-token': app.get(ConfigService).getOrThrow<string>('proxyControlToken') },
    payload: request,
  });
}

export async function resolved(
  app: NestFastifyApplication,
  request: { credential?: string; slug: string }
): Promise<Resolved> {
  const res = await resolveCaller(app, request);
  if (res.statusCode !== 200) throw new Error(`Resolving ${request.slug} answered ${res.statusCode}: ${res.body}`);
  return res.json<Resolved>();
}

export function callAsGate(answer: Resolved, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(callerIdentityHeader, answer.callerIdentity);
  return fetch(`${answer.upstream}${path}`, { ...init, headers });
}

export function gatewayUrlOf(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, '')}/api/gateway`;
}

export const RESOLVE_WEBHOOK_PATH = '/api/internal/proxy/external-services/resolve-webhook';

export interface ResolvedWebhook {
  servedBy: 'pod' | 'built-in';
  upstream: string;
  callerIdentity: string;
  tenantId: string;
  serviceId: string;
  slug: string;
}

export function resolveWebhook(app: NestFastifyApplication, request: { service: string; development?: boolean }) {
  return app.inject({
    method: 'POST',
    url: RESOLVE_WEBHOOK_PATH,
    headers: { 'x-proxy-control-token': app.get(ConfigService).getOrThrow<string>('proxyControlToken') },
    payload: request,
  });
}

export async function resolvedWebhook(
  app: NestFastifyApplication,
  request: { service: string; development?: boolean }
): Promise<ResolvedWebhook> {
  const res = await resolveWebhook(app, request);
  if (res.statusCode !== 200) {
    throw new Error(`Resolving the webhook of ${request.service} answered ${res.statusCode}: ${res.body}`);
  }
  return res.json<ResolvedWebhook>();
}

export function webhookAsGate(answer: ResolvedWebhook, rest = '', init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(callerIdentityHeader, answer.callerIdentity);
  return fetch(`${answer.upstream}/.well-known/opsiforce/webhook${rest}`, { ...init, headers });
}

export interface GateEvictionRequest {
  token: string | undefined;
  target: { tenantId?: string; slug?: string; gatewayKey?: string };
}

export interface GateControl {
  address: string;
  evictions: GateEvictionRequest[];
  close(): Promise<void>;
}

export async function startGateControl(): Promise<GateControl> {
  const evictions: GateEvictionRequest[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/evict') {
        response.writeHead(404).end();
        return;
      }
      const token = request.headers['x-proxy-control-token'];
      evictions.push({ token: typeof token === 'string' ? token : undefined, target: JSON.parse(body) });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `127.0.0.1:${port}`,
    evictions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function addressOf(app: NestFastifyApplication, answer: { servedBy: string; upstream: string }): Promise<string> {
  return answer.servedBy === 'built-in' ? `${await app.getUrl()}${answer.upstream}` : answer.upstream;
}

export async function webhookThroughGate(
  app: NestFastifyApplication,
  request: { service: string; development?: boolean },
  rest = '',
  init: RequestInit = {}
): Promise<Response> {
  const answer = await resolvedWebhook(app, request);
  const headers = new Headers(init.headers);
  headers.set(callerIdentityHeader, answer.callerIdentity);
  return fetch(`${await addressOf(app, answer)}/.well-known/opsiforce/webhook${rest}`, { ...init, headers });
}

export async function callThroughGate(
  app: NestFastifyApplication,
  request: { credential: string; slug: string },
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const answer = await resolved(app, request);
  const headers = new Headers(init.headers);
  headers.set(callerIdentityHeader, answer.callerIdentity);
  return fetch(`${await addressOf(app, answer)}${path}`, { ...init, headers });
}
