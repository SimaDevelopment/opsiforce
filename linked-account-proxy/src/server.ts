import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { MAX_BODY_BYTES, PORT, resolveBackend } from './config.ts';
import type { BackendConfig } from './config.ts';
import { CredentialUnavailableError, UnknownCallerError, createCredentialSource } from './credentials.ts';
import type { CallerAccess, CredentialSource, LinkedAccountCredential } from './credentials.ts';
import { isRecord, sendError, sendJson } from './http.ts';
import type { JsonRecord } from './http.ts';
import { UnsupportedImagesRequestError, editRequestOf, generationRequestOf } from './images.ts';
import type { ImagesRequest } from './images.ts';
import { proxyVendorAdapterOf } from './vendors.ts';
import type { ProxyVendorAdapter } from './vendors.ts';

class PayloadTooLargeError extends Error {}

const CALLER_SECRET_PREFIX = 'lap_';
const BEARER_PREFIX = 'Bearer ';

interface ResolvedCaller extends CallerAccess {
  adapter: ProxyVendorAdapter;
}

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

function handleModels(_req: IncomingMessage, res: ServerResponse, caller: ResolvedCaller): void {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: caller.adapter.models.map((id) => ({ id, object: 'model', created, owned_by: 'openai' })),
  });
}

async function bodyOf(req: IncomingMessage, res: ServerResponse, maxBodyBytes: number): Promise<Buffer | null> {
  try {
    return await readBody(req, maxBodyBytes);
  } catch (error: unknown) {
    if (error instanceof PayloadTooLargeError) {
      sendError(res, 413, { message: error.message, type: 'payload_too_large' });
      return null;
    }
    sendError(res, 400, { message: 'Failed to read the request body.', type: 'invalid_request' });
    return null;
  }
}

function jsonObjectOf(raw: Buffer, res: ServerResponse): JsonRecord | null {
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw.toString('utf-8')) : {};
  } catch {
    sendError(res, 400, { message: 'The request body must be valid JSON.', type: 'invalid_request' });
    return null;
  }
  if (!isRecord(parsed)) {
    sendError(res, 400, { message: 'The request body must be a JSON object.', type: 'invalid_request' });
    return null;
  }
  return parsed;
}

type ImagesRequestParser = (req: IncomingMessage, raw: Buffer, res: ServerResponse) => Promise<ImagesRequest | null>;

const generationOf: ImagesRequestParser = async (_req, raw, res) => {
  const body = jsonObjectOf(raw, res);
  return body && generationRequestOf(body);
};

const editOf: ImagesRequestParser = async (req, raw) => {
  const form = await new Request('http://linked-account-proxy/', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] ?? '' },
    body: raw,
  }).formData();
  return editRequestOf(form);
};

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  caller: ResolvedCaller,
  maxBodyBytes: number
) => void | Promise<void>;

const jsonPost =
  (forwardOf: (adapter: ProxyVendorAdapter) => ProxyVendorAdapter['forward']): RouteHandler =>
  async (req, res, caller, maxBodyBytes) => {
    const raw = await bodyOf(req, res, maxBodyBytes);
    const body = raw && jsonObjectOf(raw, res);
    if (body) await forwardOf(caller.adapter)(body, res, caller);
  };

const imagesPost =
  (parse: ImagesRequestParser, unreadableBody: string): RouteHandler =>
  async (req, res, caller, maxBodyBytes) => {
    const raw = await bodyOf(req, res, maxBodyBytes);
    if (!raw) return;
    let request: ImagesRequest | null;
    try {
      request = await parse(req, raw, res);
    } catch (error: unknown) {
      const message = error instanceof UnsupportedImagesRequestError ? error.message : unreadableBody;
      sendError(res, 400, { message, type: 'invalid_request_error' });
      return;
    }
    if (request) await caller.adapter.forwardImages(request, res, caller);
  };

const CALLER_ROUTES: { method: string; pathSuffix: string; handle: RouteHandler }[] = [
  { method: 'GET', pathSuffix: '/models', handle: handleModels },
  { method: 'POST', pathSuffix: '/responses', handle: jsonPost((adapter) => adapter.forward) },
  { method: 'POST', pathSuffix: '/chat/completions', handle: jsonPost((adapter) => adapter.forwardChatCompletions) },
  {
    method: 'POST',
    pathSuffix: '/images/generations',
    handle: imagesPost(generationOf, 'The request body must be valid JSON.'),
  },
  {
    method: 'POST',
    pathSuffix: '/images/edits',
    handle: imagesPost(editOf, 'The request body must be multipart form data.'),
  },
];

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

async function handleCallerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  source: CredentialSource,
  maxBodyBytes: number,
  handle: RouteHandler
): Promise<void> {
  const caller = await resolveCaller(req, res, source);
  if (caller) await handle(req, res, caller, maxBodyBytes);
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
  const route = CALLER_ROUTES.find((candidate) => candidate.method === method && path.endsWith(candidate.pathSuffix));
  if (!route) {
    sendError(res, 404, { message: 'Not found.', type: 'not_found' });
    return;
  }
  handleCallerRequest(req, res, source, maxBodyBytes, route.handle).catch(() => {
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
