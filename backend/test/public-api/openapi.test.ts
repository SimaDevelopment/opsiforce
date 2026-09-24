import { randomUUID } from 'node:crypto';
import type { OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorTypeUri } from '../../src/public-api/errors/error-types';
import { PUBLIC_API_PREFIX } from '../../src/public-api/public-api.paths';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import { assertProblemsDeclared } from './support/declared-problems';

interface ResponseSchema {
  $ref?: string;
  allOf?: [unknown, { properties?: { type?: { enum?: string[] } } }];
}

interface NamedSchema {
  properties?: Record<string, object>;
}

interface DocumentOperation {
  parameters?: { name: string }[];
  requestBody?: { content?: Record<string, { schema?: ResponseSchema }> };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: ResponseSchema }>; headers?: Record<string, unknown> }
  >;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const V1_ROUTES = [
  'DELETE /api/v1/agents/{id}/skills/{skillId}',
  'DELETE /api/v1/projects/{id}',
  'GET /api/v1/agents',
  'GET /api/v1/agents/{id}',
  'GET /api/v1/agents/{id}/skills',
  'GET /api/v1/me',
  'GET /api/v1/projects',
  'GET /api/v1/projects/{id}',
  'GET /api/v1/skills',
  'GET /api/v1/skills/{id}',
  'GET /api/v1/skills/{id}/versions/{version}/files',
  'PATCH /api/v1/agents/{id}',
  'PATCH /api/v1/skills/{id}',
  'POST /api/v1/agents',
  'POST /api/v1/projects',
  'POST /api/v1/projects/{id}/environments/{environmentId}/connect',
  'POST /api/v1/projects/{id}/restart',
  'POST /api/v1/skills',
  'POST /api/v1/skills/validate',
  'POST /api/v1/skills/{id}/duplicate',
  'POST /api/v1/skills/{id}/versions',
  'PUT /api/v1/agents/{id}/profile',
  'PUT /api/v1/agents/{id}/skills/{skillId}',
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
        'AgentDetail',
        'AgentPage',
        'AgentProfile',
        'AgentSettings',
        'AgentSkill',
        'AgentSkillList',
        'Connection',
        'CreateAgent',
        'CreateSkill',
        'CreateSkillVersion',
        'DuplicateSkill',
        'GateFinding',
        'SetAgentSkill',
        'Skill',
        'SkillFile',
        'SkillFileInput',
        'SkillFileList',
        'SkillFlags',
        'SkillList',
        'SkillValidation',
        'SkillVersionRef',
        'UpdateAgent',
        'UpdateAgentProfile',
        'UpdateSkill',
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
      'source',
      'organization',
      'organizations',
      'permissions',
      'builderSubject',
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

  describe('the declared-Problem check the harness runs on close', () => {
    it('records every Problem the app answers, against the document path', async () => {
      const res = await harness.app.inject({ method: 'GET', url: `${PUBLIC_API_PREFIX}/projects/${randomUUID()}` });
      expect(res.statusCode).toBe(401);
      expect(harness.problems).toContainEqual({
        method: 'GET',
        url: `${PUBLIC_API_PREFIX}/projects/{id}`,
        type: errorTypeUri('unauthenticated'),
      });
    });

    it('accepts a Problem its operation declares, and the ambient ones anywhere', async () => {
      await expect(
        assertProblemsDeclared(harness.app, [
          { method: 'POST', url: `${PUBLIC_API_PREFIX}/skills`, type: errorTypeUri('name-unavailable') },
          { method: 'GET', url: `${PUBLIC_API_PREFIX}/me`, type: errorTypeUri('permission-denied') },
        ])
      ).resolves.toBeUndefined();
    });

    it('fails when an operation answers a Problem it does not declare', async () => {
      await expect(
        assertProblemsDeclared(harness.app, [
          { method: 'POST', url: `${PUBLIC_API_PREFIX}/skills`, type: errorTypeUri('model-unknown') },
        ])
      ).rejects.toThrow('POST /api/v1/skills answered urn:opsiforce:error:model-unknown without declaring it');
    });

    it('fails when a Problem comes back from a route the document does not publish', async () => {
      await expect(
        assertProblemsDeclared(harness.app, [
          { method: 'DELETE', url: `${PUBLIC_API_PREFIX}/skills/{id}`, type: errorTypeUri('name-unavailable') },
        ])
      ).rejects.toThrow('DELETE /api/v1/skills/{id} answered urn:opsiforce:error:name-unavailable but the document');
    });
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
