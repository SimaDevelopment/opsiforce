import { METHODS } from 'node:http';
import { Readable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ServiceRegistry } from '../registry/service-registry';
import { BUILT_INS_ADAPTER_PATH, BuiltInsAdapter, isAdaptedBuiltIn } from './built-ins-adapter';

interface AdapterParams {
  slug: string;
}

function headersOf(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
  }
  return headers;
}

const UNROUTABLE_METHODS = new Set(['CONNECT']);

function bodyOf(request: FastifyRequest): ReadableStream<Uint8Array> | null {
  const { headers } = request.raw;
  const length = headers['content-length'];
  if (headers['transfer-encoding'] === undefined && (length === undefined || length === '0')) return null;
  return Readable.toWeb(request.raw) as ReadableStream<Uint8Array>;
}

function targetBelow(rawUrl: string, slug: string): string {
  const below = rawUrl.slice(`${BUILT_INS_ADAPTER_PATH}/${slug}`.length);
  if (below === '' || below.startsWith('?')) return `/${below}`;
  return below;
}

async function sendAnswer(reply: FastifyReply, answer: Response): Promise<void> {
  reply.status(answer.status);
  for (const [name, value] of answer.headers) {
    if (name !== 'set-cookie') reply.header(name, value);
  }
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
  await reply.send(answer.body === null ? null : Readable.fromWeb(answer.body as never));
}

export async function registerBuiltInsAdapterRoutes(app: NestFastifyApplication): Promise<void> {
  const adapter = app.get(BuiltInsAdapter);
  const registry = app.get(ServiceRegistry);

  const handle = async (request: FastifyRequest<{ Params: AdapterParams }>, reply: FastifyReply) => {
    const service = registry.bySlug(request.params.slug);
    if (!service || !isAdaptedBuiltIn(service)) {
      await reply.status(404).send({ message: 'There is no built-in External Service at this address.' });
      return;
    }
    const aborted = new AbortController();
    request.raw.once('close', () => {
      if (!request.raw.complete) aborted.abort();
    });
    reply.raw.once('close', () => aborted.abort());
    const answer = await adapter.answer(service, {
      method: request.method,
      target: targetBelow(request.raw.url ?? request.url, request.params.slug),
      headers: headersOf(request),
      body: bodyOf(request),
      signal: aborted.signal,
    });
    await sendAnswer(reply, answer);
  };

  const fastify = app.getHttpAdapter().getInstance();
  for (const method of METHODS) {
    if (!UNROUTABLE_METHODS.has(method) && !fastify.supportedMethods.includes(method)) {
      fastify.addHttpMethod(method, { hasBody: true });
    }
  }
  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null));
    for (const url of [`${BUILT_INS_ADAPTER_PATH}/:slug`, `${BUILT_INS_ADAPTER_PATH}/:slug/*`]) {
      const route = {
        method: fastify.supportedMethods,
        url,
        compress: false,
        handler: handle,
      };
      scope.route(route as unknown as Parameters<typeof scope.route>[0]);
    }
  });
}
