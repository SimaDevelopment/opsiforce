import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ErrorSlug } from '../../src/public-api/errors/error-types';
import { ERROR_MEDIA_TYPE } from '../../src/public-api/errors/error.schema';
import { PUBLIC_API_PREFIX } from '../../src/public-api/public-api.paths';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { isErrorSlug, errorsRaisedByHandlers } from './support/controller-sources';

const AMBIENT_SLUGS = new Set<ErrorSlug>([
  'validation-error',
  'unauthenticated',
  'organization-required',
  'organization-forbidden',
  'permission-denied',
  'route-not-found',
  'unexpected',
]);

interface ResponseSchema {
  $ref?: string;
  allOf?: [unknown, { properties?: { type?: { enum?: string[] } } }];
}

interface NamedSchema {
  properties?: Record<string, object>;
}

interface DocumentOperation {
  operationId?: string;
  parameters?: { name: string }[];
  requestBody?: { content?: Record<string, { schema?: ResponseSchema }> };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: ResponseSchema }>; headers?: Record<string, unknown> }
  >;
}

function declaredSlugs(document: OpenAPIObject): Map<string, Set<ErrorSlug>> {
  const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
  const declared = new Map<string, Set<ErrorSlug>>();
  for (const operations of Object.values(paths)) {
    for (const operation of Object.values(operations)) {
      const { operationId, responses } = operation;
      if (typeof operationId !== 'string') continue;
      const slugs = new Set<ErrorSlug>();
      for (const response of Object.values(responses ?? {})) {
        for (const type of response.content?.[ERROR_MEDIA_TYPE]?.schema?.allOf?.[1].properties?.type?.enum ?? []) {
          const slug = type.replace('urn:opsiforce:error:', '');
          if (isErrorSlug(slug)) slugs.add(slug);
        }
      }
      declared.set(operationId.replace(/_v\d+$/, ''), slugs);
    }
  }
  return declared;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const V1_ROUTES = [
  'DELETE /api/v1/projects/{id}',
  'GET /api/v1/agents',
  'GET /api/v1/me',
  'GET /api/v1/projects',
  'GET /api/v1/projects/{id}',
  'POST /api/v1/projects',
  'POST /api/v1/projects/{id}/environments/{environmentId}/connect',
].toSorted();

describe('public api openapi document', () => {
  let harness: PublicApiTestApp;
  let document: OpenAPIObject;

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    const res = await harness.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    document = res.json<OpenAPIObject>();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is an OpenAPI 3.1.0 document', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('tells a consumer how to reach the runtime once connected', () => {
    const description = document.info.description ?? '';
    expect(description).toContain('/api/session/{sessionId}/prompt');
    expect(description).toContain('/api/event');
    expect(description).toContain('openapiUrl');
    expect(description).toContain('@opencode-ai/client');
  });

  it('shows a worked connection rather than bare types', () => {
    const schemas = document.components?.schemas as Record<string, { example?: Record<string, unknown> }>;
    expect(schemas.Connection.example).toMatchObject({
      baseUrl: expect.stringContaining('/api/proxy/'),
      openapiUrl: expect.stringContaining('/openapi.json'),
      sessionId: expect.stringMatching(/^ses_/),
    });
    expect(schemas.OpencodeDescriptor.example).toMatchObject({ baseUrl: expect.stringContaining('/api/proxy/') });
  });

  it('documents only public-api paths', () => {
    const paths = Object.keys(document.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith(PUBLIC_API_PREFIX)).toBe(true);
  });

  it('publishes exactly the v1 route set', () => {
    const routes = Object.entries(document.paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations)
          .filter((method) => HTTP_METHODS.has(method))
          .map((method) => `${method.toUpperCase()} ${path}`)
      )
      .toSorted();

    expect(routes).toEqual(V1_ROUTES);
  });

  it('hoists every schema into components and leaves no inline $defs', () => {
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(
      expect.arrayContaining([
        'Agent',
        'AgentPage',
        'Connection',
        'CreateProject',
        'Environment',
        'Me',
        'OpencodeDescriptor',
        'OrganizationRef',
        'ApiError',
        'Project',
        'ProjectPage',
        'ResourceRef',
        'ValidationErrorItem',
        'WorkspaceRef',
      ])
    );
    expect(JSON.stringify(document)).not.toContain('"$defs"');
    expect(JSON.stringify(document)).not.toContain('"$schema"');
  });

  it('documents the me route against the hoisted Me schema', () => {
    const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
    const schema = paths[`${PUBLIC_API_PREFIX}/me`].get.responses?.['200'].content?.['application/json'].schema;
    expect(schema).toEqual({ $ref: '#/components/schemas/Me' });

    const schemas = document.components?.schemas as Record<string, NamedSchema> | undefined;
    expect(Object.keys(schemas?.Me.properties ?? {})).toEqual([
      'id',
      'username',
      'email',
      'displayName',
      'organization',
      'organizations',
      'permissions',
    ]);
  });

  it('documents the agents and projects routes against their hoisted schemas', () => {
    const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
    const responseSchema = (path: string): ResponseSchema | undefined =>
      paths[path].get.responses?.['200'].content?.['application/json'].schema;

    expect(responseSchema(`${PUBLIC_API_PREFIX}/agents`)).toEqual({ $ref: '#/components/schemas/AgentPage' });
    expect(responseSchema(`${PUBLIC_API_PREFIX}/projects`)).toEqual({ $ref: '#/components/schemas/ProjectPage' });
    expect(responseSchema(`${PUBLIC_API_PREFIX}/projects/{id}`)).toEqual({ $ref: '#/components/schemas/Project' });
  });

  it('documents the create and delete routes of a Project', () => {
    const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
    const create = paths[`${PUBLIC_API_PREFIX}/projects`].post;

    expect(create.requestBody?.content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CreateProject',
    });
    expect(create.responses?.['201'].content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Project',
    });

    const remove = paths[`${PUBLIC_API_PREFIX}/projects/{id}`].delete;
    expect(Object.keys(remove.responses ?? {})).toContain('204');
    expect(remove.responses?.['204'].content).toBeUndefined();
  });

  it('documents the connection route and the discovery an Environment carries', () => {
    const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
    const connect = paths[`${PUBLIC_API_PREFIX}/projects/{id}/environments/{environmentId}/connect`].post;

    expect(connect.responses?.['200'].content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Connection',
    });
    expect((connect.parameters ?? []).map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['id', 'environmentId'])
    );
    expect(Object.keys(connect.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '404', '423', '502', '503', '504'])
    );
    expect(connect.responses?.['503'].headers).toMatchObject({
      'retry-after': { schema: { type: 'integer', example: 5 } },
    });

    const schemas = document.components?.schemas as Record<string, NamedSchema> | undefined;
    expect(Object.keys(schemas?.Connection.properties ?? {})).toEqual(['baseUrl', 'openapiUrl', 'sessionId', 'build']);
    expect(Object.keys(schemas?.OpencodeDescriptor.properties ?? {})).toEqual(['baseUrl', 'openapiUrl', 'sessionId']);
    expect(Object.keys(schemas?.Environment.properties ?? {})).toContain('opencode');
  });

  it('documents the pagination and filter parameters of the list routes', () => {
    const paths = document.paths as Record<string, Record<string, DocumentOperation>>;
    const names = (path: string): string[] => (paths[path].get.parameters ?? []).map((parameter) => parameter.name);

    expect(names(`${PUBLIC_API_PREFIX}/agents`)).toEqual(expect.arrayContaining(['limit', 'cursor']));
    expect(names(`${PUBLIC_API_PREFIX}/projects`)).toEqual(
      expect.arrayContaining(['limit', 'cursor', 'workspaceId', 'agentId'])
    );
    expect(names(`${PUBLIC_API_PREFIX}/projects/{id}`)).toContain('id');
  });

  it('declares the bearer scheme and the organization header', () => {
    expect(document.components?.securitySchemes?.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    const parameters = Object.values(document.paths).flatMap((operations) =>
      Object.values(operations).flatMap((operation) =>
        typeof operation === 'object' && operation !== null && 'parameters' in operation
          ? (operation.parameters ?? [])
          : []
      )
    );
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'x-tenant-name', in: 'header' }));
  });

  it('never lets a handler raise a ApiError it does not declare', () => {
    const declared = declaredSlugs(document);
    const raised = errorsRaisedByHandlers();
    expect(raised.size).toBeGreaterThan(0);
    for (const [operationId, slugs] of declared) {
      const handlerSlugs = raised.get(operationId);
      expect(handlerSlugs, `no handler found for operation ${operationId}`).toBeDefined();
      const undeclared = [...(handlerSlugs ?? [])].filter((slug) => !slugs.has(slug) && !AMBIENT_SLUGS.has(slug));
      expect(undeclared, `${operationId} raises undeclared errors`).toEqual([]);
    }
  });

  it('serves the Scalar reference without a token', async () => {
    const redirect = await harness.app.inject({ method: 'GET', url: '/api/v1/docs' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/api/v1/docs/');

    const res = await harness.app.inject({ method: 'GET', url: '/api/v1/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});
