import type { INestApplication } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type StandardSchemaConverter } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { TENANT_NAME_HEADER } from '../tenant/tenant.decorator';
import { REQUEST_ID_HEADER } from './errors/error-details.filter';
import { isPublicApiPath } from './public-api.paths';
import { ApiErrorSchema } from './errors/error.schema';
import { PUBLIC_API_RESOURCE_MODULES } from './public-api.module';
import { readRuntimeDocument } from './runtime-document';

export const OPENAPI_JSON_PATH = '/api/v1/openapi.json';
export const RUNTIME_OPENAPI_JSON_PATH = '/api/v1/runtime/openapi.json';
export const DOCS_PATH = '/api/v1/docs';

const API_DESCRIPTION = [
  "Programmatic access to Opsiforce: who you are, the Agent registry, your Projects, and a connection to a Project's Agent runtime. Everything documented here is the platform's own surface. The conversation itself is not: you reach it natively, at the runtime's own API.",
  "**Authentication.** Send the bearer token your deployment's identity provider issues when you sign in. If you belong to more than one tenant, name it with the `x-tenant-name` header; with one membership it is implied.",
  '**Model.** A tenant owns Projects. Each Project runs environments, and each environment runs an opencode runtime. Every environment reports an `opencode` descriptor — where its runtime is, where its own OpenAPI document is, and the primary Session every surface shares.',
  '**Talking to the Agent.** Call `POST /projects/{id}/environments/{environmentId}/connect`. It wakes the environment, binds the primary Session and tells you which build answered. Everything after that goes to the runtime at `baseUrl`, in opencode’s own shapes:',
  [
    '```',
    'POST  {baseUrl}/api/session/{sessionId}/prompt     {"id":"msg_…","text":"…"}',
    'GET   {baseUrl}/api/session/{sessionId}/message?limit=50&order=desc',
    'GET   {baseUrl}/api/event                          (server-sent events)',
    'POST  {baseUrl}/api/session/{sessionId}/wait       (returns once the Session is idle)',
    'POST  {baseUrl}/api/session/{sessionId}/interrupt',
    'GET   {baseUrl}/api/session/{sessionId}/inbox',
    '```',
  ].join('\n'),
  '**Where that API is documented.** Two places, for two purposes. Pick **Agent Runtime (opencode)** in the document selector to browse it here: a snapshot of the build this deployment ships, readable without waking anything, with a server variable to point it at one of your environments. For a *running* environment, the authoritative document is the `openapiUrl` that `connect` reports — served by that pod, at that build, fetched with the same bearer token from the same origin. The matching client is `@opencode-ai/client`, installed at exactly the `build` that `connect` returned.',
  '**Two things to know before writing against it.** Native `wait` means the Session went idle, not that your prompt succeeded — read the outcome from the messages or the events. And send your own `id` on a prompt so a retry is harmless: the runtime returns the first admission again for the same id and body, and conflicts on a different one.',
  '**Discovery URLs are origin-relative.** Resolve `baseUrl` and `openapiUrl` against the origin you called this API on, and send your bearer token only to that origin.',
  "**Errors.** Every failure on this API is an error document with a stable `type` URN, a human `detail` and the request id in `instance`, also echoed as `X-Request-Id`, served as `application/problem+json` (RFC 9457). Failures on the runtime path are the runtime's own errors, or the edge's: a starting environment answers 503 with `Retry-After`.",
  '**Compatibility.** The major version is in the path. Within v1 changes are additive only: new routes, optional fields, query parameters and enum values. Ignore what you do not recognise. Fields are never removed or retyped; deprecated ones are marked and keep working for the life of v1. Breaking changes ship as `/api/v2` alongside v1. This policy covers the platform resources documented here; the runtime API behind `baseUrl` is the protocol of the deployed build and moves with it.',
].join('\n\n');

interface JsonSchemaWithDefs {
  $schema?: string;
  $defs?: Record<string, unknown>;
  [key: string]: unknown;
}

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaWithDefs {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as JsonSchemaWithDefs;
}

const zodConverter: StandardSchemaConverter = (schema, { schemaType }) => {
  if (!(schema instanceof z.ZodType)) return undefined;
  const { $schema: _ignored, $defs, ...rest } = toJsonSchema(schema, schemaType);
  return { schema: rest, components: $defs ?? {} };
};

export function buildPublicApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Opsiforce Public API')
    .setDescription(API_DESCRIPTION)
    .setVersion('1')
    .setOpenAPIVersion('3.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addGlobalParameters({
      name: TENANT_NAME_HEADER,
      in: 'header',
      required: false,
      description: 'Tenant to act in; required only for callers that belong to several tenants',
      schema: { type: 'string' },
    })
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    include: PUBLIC_API_RESOURCE_MODULES,
    standardSchemaConverter: zodConverter,
  });
  const { $defs: errorDefs = {} } = toJsonSchema(ApiErrorSchema, 'output');
  document.components = {
    ...document.components,
    schemas: {
      ...document.components?.schemas,
      ...(errorDefs as NonNullable<OpenAPIObject['components']>['schemas']),
    },
  };
  return document;
}

export async function setupPublicApi(app: NestFastifyApplication): Promise<void> {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', (request, reply, payload, done) => {
    if (isPublicApiPath(request.url)) reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });

  const document = buildPublicApiDocument(app);
  fastify.get(OPENAPI_JSON_PATH, (_request, reply) => reply.send(document));

  const runtimeDocument = readRuntimeDocument();
  if (runtimeDocument) {
    fastify.get(RUNTIME_OPENAPI_JSON_PATH, (_request, reply) => reply.send(runtimeDocument));
  }

  await fastify.register(import('@scalar/fastify-api-reference'), {
    routePrefix: DOCS_PATH,
    configuration: {
      pageTitle: 'Opsiforce Public API',
      title: 'Opsiforce Public API',
      sources: [
        { slug: 'platform', title: 'Platform API', url: OPENAPI_JSON_PATH, default: true },
        ...(runtimeDocument
          ? [{ slug: 'runtime', title: 'Agent Runtime (opencode)', url: RUNTIME_OPENAPI_JSON_PATH }]
          : []),
      ],
    },
  });
}
