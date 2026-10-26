import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createProxy } from '../src/server.ts';

const CHATGPT_HOSTNAME = 'chatgpt.com';

export const LINKED_ACCOUNT = {
  accessToken: 'chatgpt-access-token',
  accountId: 'chatgpt-account-123',
};

export const CALLER_SECRET = 'lap_known-caller-secret';

export const BIFROST_AUTHORIZATION = `Bearer ${CALLER_SECRET}`;

export const SERVICE_TOKEN = 'linked-account-proxy-service-token';

const HOUR_MS = 60 * 60 * 1000;

export interface UpstreamRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type UpstreamResponder = (res: ServerResponse) => void;

export interface FakeChatGptUpstream {
  port: number;
  requests: UpstreamRequest[];
  respondWith(responder: UpstreamResponder): void;
  close(): Promise<void>;
}

export interface CredentialRequest {
  serviceToken: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeBackend {
  url: string;
  requests: CredentialRequest[];
  expireTokensIn(ms: number): void;
  refreshedTokens: () => string[];
  becomeUnreachable(): void;
  becomeReachable(): void;
  reset(): void;
  close(): Promise<void>;
}

export interface RunningProxy {
  baseUrl: string;
  port: number;
  upstream: FakeChatGptUpstream;
  backend: FakeBackend;
  sendLikeBifrost(body: unknown, authorization?: string): Promise<Response>;
  postLikeBifrost(path: string, body: string | FormData): Promise<Response>;
  stop(): Promise<void>;
}

export const event = (data: { type: string } & Record<string, unknown>) => ({ event: data.type, data });

export function respondWithEventStream(events: readonly { event: string; data: unknown }[]): UpstreamResponder {
  return (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const { event: name, data } of events) {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function startFakeChatGptUpstream(): Promise<FakeChatGptUpstream> {
  const requests: UpstreamRequest[] = [];
  let responder: UpstreamResponder = respondWithEventStream([]);
  const recordAndRespond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const body = await readJson(req);
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      responder(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  };
  const server = createServer((req, res) => void recordAndRespond(req, res));
  const port = await listen(server);
  return {
    port,
    requests,
    respondWith(next) {
      responder = next;
    },
    close: () => closeServer(server),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startFakeBackend(): Promise<FakeBackend> {
  const requests: CredentialRequest[] = [];
  let tokenLifetimeMs = HOUR_MS;
  let refreshed: string[] = [];
  let unreachable = false;
  const answer = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const serviceToken = req.headers['x-linked-account-proxy-token'] as string | undefined;
    requests.push({ serviceToken, body });
    if (req.method !== 'POST' || req.url !== '/api/internal/linked-accounts/credential') return sendJson(res, 404, {});
    if (serviceToken !== SERVICE_TOKEN) return sendJson(res, 401, { message: 'Invalid service token' });
    if (body.caller_secret !== CALLER_SECRET) return sendJson(res, 401, { message: 'Unknown Linked-account caller' });
    if (body.force_refresh === true)
      refreshed = [...refreshed, `chatgpt-access-token-refreshed-${refreshed.length + 1}`];
    sendJson(res, 200, {
      vendor: 'chatgpt',
      accessToken: refreshed.at(-1) ?? LINKED_ACCOUNT.accessToken,
      accountId: LINKED_ACCOUNT.accountId,
      expiresAt: new Date(Date.now() + tokenLifetimeMs).toISOString(),
    });
  };
  const server = createServer((req, res) => {
    if (unreachable) {
      req.socket.destroy();
      return;
    }
    answer(req, res).catch(() => sendJson(res, 500, {}));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    expireTokensIn(ms) {
      tokenLifetimeMs = ms;
    },
    refreshedTokens: () => refreshed,
    becomeUnreachable() {
      unreachable = true;
    },
    becomeReachable() {
      unreachable = false;
    },
    reset() {
      requests.length = 0;
      tokenLifetimeMs = HOUR_MS;
      refreshed = [];
      unreachable = false;
    },
    close: () => closeServer(server),
  };
}

function routeChatGptTo(upstreamPort: number): () => void {
  const unroutedFetch = globalThis.fetch;
  const routedFetch: typeof fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.protocol !== 'https:' || target.hostname !== CHATGPT_HOSTNAME) return unroutedFetch(input, init);
    target.protocol = 'http:';
    target.host = `127.0.0.1:${upstreamPort}`;
    return unroutedFetch(target, init);
  };
  globalThis.fetch = routedFetch;
  return () => {
    if (globalThis.fetch === routedFetch) globalThis.fetch = unroutedFetch;
  };
}

export async function startLinkedAccountProxy(options: { maxBodyBytes: number }): Promise<RunningProxy> {
  const upstream = await startFakeChatGptUpstream();
  const backend = await startFakeBackend();
  const unrouteChatGpt = routeChatGptTo(upstream.port);
  const server = createProxy({
    backend: { url: backend.url, serviceToken: SERVICE_TOKEN },
    maxBodyBytes: options.maxBodyBytes,
  });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    await closeServer(server);
    unrouteChatGpt();
    await upstream.close();
    await backend.close();
  };

  return {
    baseUrl,
    port,
    upstream,
    backend,
    sendLikeBifrost: (body, authorization = BIFROST_AUTHORIZATION) =>
      fetch(`${baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    postLikeBifrost: (path, body) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: BIFROST_AUTHORIZATION,
          ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
        },
        body,
      }),
    stop,
  };
}
