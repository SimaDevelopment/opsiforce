import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, PORT, resolveBackend } from './config.ts';
import type { BackendConfig } from './config.ts';
import { CredentialUnavailableError, UnknownCallerError, createCredentialSource } from './credentials.ts';
import type { CallerCredentials, CredentialSource, LinkedAccountCredential } from './credentials.ts';
import { sendError, sendJson } from './http.ts';
import type { JsonRecord } from './http.ts';
import { proxyVendorAdapterOf } from './vendors.ts';
import type { ProxyVendorAdapter } from './vendors.ts';

class PayloadTooLargeError extends Error {}

const CALLER_SECRET_PREFIX = 'lap_';
const BEARER_PREFIX = 'Bearer ';

interface ResolvedCaller {
  credentials: CallerCredentials;
  credential: LinkedAccountCredential;
  adapter: ProxyVendorAdapter;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new PayloadTooLargeError(`Request body exceeds the ${maxBytes}-byte limit.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function callerSecretOf(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith(BEARER_PREFIX)) return null;
  const secret = authorization.slice(BEARER_PREFIX.length).trim();
  return secret.startsWith(CALLER_SECRET_PREFIX) ? secret : null;
}

async function resolveCaller(
  req: IncomingMessage,
  res: ServerResponse,
  source: CredentialSource
): Promise<ResolvedCaller | null> {
  const secret = callerSecretOf(req);
  if (!secret) {
    sendError(res, 401, { message: 'The request carries no Linked-account key.', type: 'unknown_caller' });
    return null;
  }
  const credentials = source.forCaller(secret);
  let credential: LinkedAccountCredential;
  try {
    credential = await credentials.current();
  } catch (error: unknown) {
    if (error instanceof UnknownCallerError) {
      sendError(res, 401, { message: error.message, type: 'unknown_caller' });
      return null;
    }
    const message = error instanceof CredentialUnavailableError ? error.message : 'The Linked account is unavailable.';
    sendError(res, 502, { message, type: 'linked_account_unavailable' });
    return null;
  }
  const adapter = proxyVendorAdapterOf(credential.vendor);
  if (!adapter) {
    sendError(res, 502, { message: `No Vendor adapter for ${credential.vendor}.`, type: 'unknown_vendor' });
    return null;
  }
  return { credentials, credential, adapter };
}

function handleModels(res: ServerResponse, caller: ResolvedCaller): void {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: caller.adapter.models.map((id) => ({ id, object: 'model', created, owned_by: 'openai' })),
  });
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
  caller: ResolvedCaller
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readBody(req, maxBodyBytes);
  } catch (error: unknown) {
    if (error instanceof PayloadTooLargeError) {
      sendError(res, 413, { message: error.message, type: 'payload_too_large' });
      return;
    }
    sendError(res, 400, { message: 'Failed to read the request body.', type: 'invalid_request' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString('utf-8')) : {};
  } catch {
    sendError(res, 400, { message: 'The request body must be valid JSON.', type: 'invalid_request' });
    return;
  }
  if (!isRecord(parsed)) {
    sendError(res, 400, { message: 'The request body must be a JSON object.', type: 'invalid_request' });
    return;
  }
  await caller.adapter.forward(parsed, res, caller.credentials, caller.credential);
}

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

type CallerRoute = 'models' | 'responses';

function callerRouteOf(method: string, path: string): CallerRoute | null {
  if (method === 'GET' && path.endsWith('/models')) return 'models';
  if (method === 'POST' && path.endsWith('/responses')) return 'responses';
  return null;
}

async function handleCallerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  source: CredentialSource,
  maxBodyBytes: number,
  route: CallerRoute
): Promise<void> {
  const caller = await resolveCaller(req, res, source);
  if (!caller) return;
  if (route === 'models') handleModels(res, caller);
  else await handleResponses(req, res, maxBodyBytes, caller);
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  source: CredentialSource,
  maxBodyBytes: number
): void {
  const path = requestPath(req);
  const method = req.method ?? 'GET';

  if (method === 'GET' && path.endsWith('/healthz')) {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  const route = callerRouteOf(method, path);
  if (!route) {
    sendError(res, 404, { message: 'Not found.', type: 'not_found' });
    return;
  }
  handleCallerRequest(req, res, source, maxBodyBytes, route).catch(() => {
    if (res.headersSent) res.destroy();
    else sendError(res, 500, { message: 'Internal proxy error.', type: 'linked_account_proxy_error' });
  });
}

export function createProxy(options: { backend: BackendConfig; maxBodyBytes: number }): Server {
  const source = createCredentialSource(options.backend);
  return createServer((req, res) => handleRequest(req, res, source, options.maxBodyBytes));
}

export function startServer(): void {
  const server = createProxy({ backend: resolveBackend(), maxBodyBytes: MAX_BODY_BYTES });
  server.listen(PORT, () => {
    process.stdout.write(`linked-account-proxy listening on port ${PORT}\n`);
  });
  process.once('SIGTERM', () => {
    server.close();
    server.closeIdleConnections();
  });
}
