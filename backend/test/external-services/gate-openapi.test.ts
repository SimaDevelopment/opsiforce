import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callTokenFor } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { fixtureCrmEvolved } from './support/evolved-built-ins';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  askGate,
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';
import { expectOpenApi31, requestValidator, type DocumentOperation, type ServiceDocument } from './support/openapi';

const OPENAPI_PATH = `${FIXTURE_SERVICE}/openapi.json`;

function declaredCodes(operation: DocumentOperation, status: number): string[] {
  const examples = operation.responses[String(status)]?.content?.['application/problem+json']?.examples ?? {};
  return Object.values(examples).map((example) => example.value.code);
}

describe('openapi.json: the live document of a service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let caller: GateCallerFixture;
  let mailbox: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    [mailbox] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [string];
    caller = await gateCaller(app);
  });

  async function fetchDocument(key: string = caller.key): Promise<ServiceDocument> {
    const res = await askGate(app, { key, path: OPENAPI_PATH });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ServiceDocument>();
  }

  it('is a valid OpenAPI 3.1 document', async () => {
    const document = await fetchDocument();

    expectOpenApi31(document);
    expect(document.info.title).toBe('Fixture CRM');
    expect(document.servers).toEqual([{ url: `/api/external-services/agent/${FIXTURE_SERVICE}` }]);
    expect(document.components?.securitySchemes).toMatchObject({ serviceKey: { type: 'http', scheme: 'bearer' } });
  });

  it('documents each Operation as a POST taking its input as the body', async () => {
    const document = await fetchDocument();

    expect(Object.keys(document.paths).toSorted()).toEqual([
      '/delete_account',
      '/get_account',
      '/get_member',
      '/update_account',
    ]);
    for (const item of Object.values(document.paths)) expect(Object.keys(item)).toEqual(['post']);

    const getAccount = document.paths['/get_account'].post;
    expect(getAccount).toMatchObject({
      operationId: 'get_account',
      description: expect.stringContaining('Read one account the Project configuration allows.'),
      'x-opsiforce-kind': 'read',
    });
    expect(document.paths['/update_account'].post).toMatchObject({
      summary: 'Update account',
      'x-opsiforce-kind': 'write',
    });
    expect(document.paths['/delete_account'].post['x-opsiforce-kind']).toBe('destructive');
    expect(getAccount.requestBody?.required).toBe(true);

    const validGetAccount = requestValidator(document, '/get_account');
    expect(validGetAccount({ accountId: 'acc_1' })).toBe(true);
    expect(validGetAccount({})).toBe(false);
    expect(validGetAccount({ accountId: 'acc_1', extra: true })).toBe(false);
    const validUpdate = requestValidator(document, '/update_account');
    expect(validUpdate({ accountId: 'acc_1', pipeline: 'sales', name: 'Acme Ltd' })).toBe(true);
    expect(validUpdate({ accountId: 'acc_1', pipeline: 'sales', name: '' })).toBe(false);
  });

  it('shows the output example as the 200 example', async () => {
    const document = await fetchDocument();

    expect(document.paths['/get_account'].post.responses['200'].content?.['application/json']?.example).toEqual({
      id: 'acc_1',
      name: 'Acme',
    });
    expect(document.paths['/get_member'].post.responses['200'].content?.['application/json']?.example).toBeUndefined();
  });

  it('explains the bound inputs', async () => {
    const document = await fetchDocument();
    const schemas = document.components?.schemas as Record<
      string,
      { properties: Record<string, Record<string, unknown>> }
    >;

    expect(schemas.AccountRef.properties.accountId).toMatchObject({
      'x-opsiforce-bound': 'account',
      description: expect.stringContaining('accountIds'),
    });
    expect(schemas.AccountRef.properties.accountId).not.toHaveProperty('boundTo');
    expect(JSON.stringify(document)).not.toContain('"boundTo"');
    expect(document.paths['/get_account'].post.description).toMatch(/`accountId`.*`account`/s);
    expect(document.paths['/get_account'].post.description).toContain('accountsMode');
    expect(document.paths['/get_member'].post.description).toMatch(/`memberId`.*`member`/s);
  });

  it('declares the problems the Gate answers', async () => {
    const document = await fetchDocument();
    const getAccount = document.paths['/get_account'].post;

    expect(declaredCodes(getAccount, 400)).toContain('invalid-input');
    expect(declaredCodes(getAccount, 401)).toContain('unauthorized');
    expect(declaredCodes(getAccount, 403)).toEqual(expect.arrayContaining(['operation-off', 'out-of-bounds']));
    expect(declaredCodes(getAccount, 409)).toContain('configuration-incomplete');
    expect(declaredCodes(getAccount, 413)).toContain('input-too-large');
    expect(declaredCodes(getAccount, 502)).toContain('service-failed');
    expect(declaredCodes(getAccount, 503)).toContain('service-not-configured');
    expect(getAccount.responses['403'].content?.['application/problem+json']?.schema).toEqual({
      $ref: '#/components/schemas/opsiforce.Problem',
    });
  });

  it('declares every refusal an Operation call gets', async () => {
    const document = await fetchDocument();
    const refusals: { operation: string; input: unknown }[] = [
      { operation: 'get_account', input: { accountId: 'acc_1' } },
      { operation: 'delete_account', input: { accountId: 'acc_1' } },
      { operation: 'get_account', input: {} },
      { operation: 'get_account', input: { accountId: 'acc_2' } },
      { operation: 'update_account', input: { accountId: 'acc_1', pipeline: 'sales', name: 'x'.repeat(2000) } },
    ];
    const observed: { operation: string; status: number; code: string }[] = [];

    const unconfigured = await callOperation(app, { key: caller.key, slug: FIXTURE_SERVICE, ...refusals[0] });
    observed.push({ operation: 'get_account', status: unconfigured.statusCode, code: unconfigured.json().code });
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
      mailbox,
      accountIds: ['acc_1'],
      operations: { update_account: true },
    });
    for (const refusal of refusals.slice(1)) {
      const res = await callOperation(app, { key: caller.key, slug: FIXTURE_SERVICE, ...refusal });
      observed.push({ operation: refusal.operation, status: res.statusCode, code: res.json().code });
    }
    const unauthorized = await callOperation(app, { slug: FIXTURE_SERVICE, ...refusals[0] });
    observed.push({ operation: 'get_account', status: unauthorized.statusCode, code: unauthorized.json().code });

    expect(observed.map(({ code }) => code)).toEqual([
      'configuration-incomplete',
      'operation-off',
      'invalid-input',
      'out-of-bounds',
      'input-too-large',
      'unauthorized',
    ]);
    for (const { operation, status, code } of observed) {
      expect(declaredCodes(document.paths[`/${operation}`].post, status), `${operation} ${status}`).toContain(code);
    }
  });

  describe('caching', () => {
    it('tags the document with the manifest hash', async () => {
      const res = await askGate(app, { key: caller.key, path: OPENAPI_PATH });

      expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      const described = await askGate(app, { key: caller.key, path: FIXTURE_SERVICE });
      expect(res.headers.etag).toBe(`"${described.json().manifestHash}"`);
    });

    it('answers 304 to a matching If-None-Match and the document to a stale one', async () => {
      const first = await askGate(app, { key: caller.key, path: OPENAPI_PATH });
      const etag = first.headers.etag as string;

      const fresh = await askGate(app, { key: caller.key, path: OPENAPI_PATH, headers: { 'if-none-match': etag } });
      expect(fresh.statusCode).toBe(304);
      expect(fresh.body).toBe('');
      expect(fresh.headers.etag).toBe(etag);

      const weak = await askGate(app, {
        key: caller.key,
        path: OPENAPI_PATH,
        headers: { 'if-none-match': `"stale", W/${etag}` },
      });
      expect(weak.statusCode).toBe(304);

      const stale = await askGate(app, {
        key: caller.key,
        path: OPENAPI_PATH,
        headers: { 'if-none-match': '"stale"' },
      });
      expect(stale.statusCode).toBe(200);
      expect(stale.json().openapi).toBe('3.1.0');
    });

    it('changes when the manifest changes', async () => {
      const before = await askGate(app, { key: caller.key, path: OPENAPI_PATH });
      const evolved = await fixtureCrmEvolved((manifest) => {
        manifest.operations.get_account.description = 'Read one allowed account, with its owner.';
      });
      const next = await createExternalServicesTestApp({ builtInsDir: evolved.dir });
      try {
        await configurePlatformService(next.app, FIXTURE_SERVICE, READY_FIXTURE_CRM);
        const nextCaller = await gateCaller(next.app);

        const after = await askGate(next.app, {
          key: nextCaller.key,
          path: OPENAPI_PATH,
          headers: { 'if-none-match': before.headers.etag as string },
        });

        expect(after.statusCode, after.body).toBe(200);
        expect(after.headers.etag).not.toBe(before.headers.etag);
        expect(after.json().paths['/get_account'].post.description).toContain('with its owner');
      } finally {
        await next.close();
        await evolved.remove();
      }
    });
  });

  describe('refused', () => {
    it('without a service key', async () => {
      const res = await askGate(app, { path: OPENAPI_PATH });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('unauthorized');
    });

    it('with a call token in place of the environment service key', async () => {
      const res = await askGate(app, {
        key: callTokenFor(app, caller.tenant, caller.projectId),
        path: OPENAPI_PATH,
      });

      expect(res.statusCode).toBe(401);
    });

    it('for a service that does not exist', async () => {
      const res = await askGate(app, { key: caller.key, path: 'no-such-service/openapi.json' });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('unknown-service');
    });
  });

  describe('never on the public docs', () => {
    it('leaves the service out of /api/v1/openapi.json', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });

      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json().paths).filter((path) => path.includes('external-services'))).toEqual([]);
      for (const name of ['get_account', 'update_account', 'Fixture CRM', 'opsiforce.Problem']) {
        expect(res.body).not.toContain(name);
      }
    });

    it('lists no service document among the Scalar sources', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/docs/' });

      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('external-services');
      expect(res.body).not.toContain('Fixture CRM');
    });
  });
});
