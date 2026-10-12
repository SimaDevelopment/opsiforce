import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  callRow,
  callRowsOf,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  storeProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

const PROBLEM_JSON = 'application/problem+json; charset=utf-8';

describe('an Operation call through the Gate', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let caller: GateCallerFixture;
  let mailbox: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    [mailbox] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [string];
    caller = await gateCaller(app);
  });

  function configureProject(values: Record<string, unknown>) {
    return saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, { mailbox, ...values });
  }

  function call(operation: string, input: unknown, headers?: Record<string, string>) {
    return callOperation(app, { key: caller.key, slug: FIXTURE_SERVICE, operation, input, headers });
  }

  describe('allowed', () => {
    it('reaches the built-in for an Agent and logs an allowed Call with sizes and no body', async () => {
      await configureProject({ accountIds: ['acc_1'], _labels: { accountIds: { acc_1: 'Acme' } } });

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ id: 'acc_1', name: 'Acme', mailboxes: ['Support'] });
      const [row] = await callRowsOf(caller.projectEnvironmentId);
      expect(row).toMatchObject({
        kind: 'operation',
        via: 'agent',
        externalServiceId: serviceId,
        slug: FIXTURE_SERVICE,
        tenantId: caller.tenant.tenantId,
        projectId: caller.projectId,
        projectTitle: caller.projectTitle,
        projectEnvironmentId: caller.projectEnvironmentId,
        operation: 'get_account',
        operationKind: 'read',
        decision: 'allowed',
        status: 200,
        code: null,
        detail: null,
        bounds: [{ bound: 'account', pointer: '/accountId', value: 'acc_1', label: 'Acme' }],
        inputBytes: Buffer.byteLength(JSON.stringify({ accountId: 'acc_1' })),
        outputBytes: Buffer.byteLength(res.body),
      });
      expect(row?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(row)).not.toContain('Sales');
    });

    it('reaches the built-in for an App, labelled app in the Call log', async () => {
      await configureProject({ accountIds: ['acc_2'] });

      const res = await call('get_account', { accountId: 'acc_2' }, { 'x-opsiforce-via': 'app' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ id: 'acc_2', name: 'Globex' });
      const [row] = await callRowsOf(caller.projectEnvironmentId);
      expect(row).toMatchObject({ via: 'app', decision: 'allowed', status: 200 });
    });

    it('fills input defaults before the service sees the input', async () => {
      await configureProject({ accountIds: ['acc_1'], pipeline: 'sales', operations: { update_account: true } });

      const res = await call('update_account', { accountId: 'acc_1', pipeline: 'sales', name: 'Acme Ltd' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ id: 'acc_1', name: 'Acme Ltd', pipeline: 'sales' });
    });
  });

  describe('refused', () => {
    it('401 without a service key: nothing about the caller is known and nothing else ran', async () => {
      const res = await callOperation(app, { slug: FIXTURE_SERVICE, operation: 'get_account', input: {} });

      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({ type: 'urn:opsiforce:error:unauthorized', status: 401, code: 'unauthorized' });
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 401,
        code: 'unauthorized',
        slug: FIXTURE_SERVICE,
        operation: 'get_account',
        tenantId: null,
        projectEnvironmentId: null,
        externalServiceId: null,
        outputBytes: null,
      });
    });

    it('401 for a key that is not an environment service key', async () => {
      const res = await callOperation(app, {
        key: 'gw-not-a-key',
        slug: FIXTURE_SERVICE,
        operation: 'get_account',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('unauthorized');
    });

    it('404 unknown-service after the caller is known', async () => {
      const res = await callOperation(app, { key: caller.key, slug: 'no-such-service', operation: 'get_account' });

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({ type: 'urn:opsiforce:error:unknown-service', code: 'unknown-service' });
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 404,
        code: 'unknown-service',
        slug: 'no-such-service',
        tenantId: caller.tenant.tenantId,
        projectEnvironmentId: caller.projectEnvironmentId,
        externalServiceId: null,
        manifestHash: null,
      });
    });

    it('503 service-not-configured while the platform Service configuration is incomplete', async () => {
      await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({ type: 'urn:opsiforce:error:service-not-configured', status: 503 });
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 503,
        code: 'service-not-configured',
        externalServiceId: serviceId,
        tenantId: caller.tenant.tenantId,
        manifestHash: null,
        operationKind: null,
      });
    });

    it('404 unknown-operation once the service and its manifest are known', async () => {
      const res = await call('drop_everything', {});

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body).toMatchObject({ type: 'urn:opsiforce:error:unknown-operation', operation: 'drop_everything' });
      const row = await callRow(body.callId);
      expect(row).toMatchObject({ decision: 'refused', status: 404, code: 'unknown-operation', operationKind: null });
      expect(row?.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('409 configuration-incomplete when the Project configuration misses a required field', async () => {
      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode).toBe(409);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({
        type: 'urn:opsiforce:error:configuration-incomplete',
        status: 409,
        missing: ['mailbox'],
      });
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 409,
        code: 'configuration-incomplete',
        operationKind: 'read',
        bounds: null,
      });
    });

    it('409 configuration-incomplete when a stored value no longer fits the Project form', async () => {
      await storeProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId, {
        mailbox: 42,
        operations: { get_account: true },
      });

      const res = await call('get_account', { accountId: 'acc_1' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'configuration-incomplete', missing: ['mailbox'] });
    });

    it('403 operation-off for a write Operation a new configuration leaves off', async () => {
      await configureProject({ accountIds: ['acc_1'], pipeline: 'sales' });

      const res = await call('update_account', { accountId: 'acc_1', pipeline: 'sales', name: 'x' });

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({
        type: 'urn:opsiforce:error:operation-off',
        status: 403,
        operation: 'update_account',
      });
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 403,
        code: 'operation-off',
        operationKind: 'write',
        bounds: null,
        outputBytes: null,
      });
    });

    it('413 input-too-large before the input is validated', async () => {
      await configureProject({ accountIds: ['acc_1'], pipeline: 'sales', operations: { update_account: true } });

      const res = await call('update_account', { accountId: 'acc_1', pipeline: 'sales', name: 'x'.repeat(2000) });

      expect(res.statusCode).toBe(413);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({
        type: 'urn:opsiforce:error:input-too-large',
        status: 413,
        operation: 'update_account',
        limit: 1024,
      });
      const row = await callRow(body.callId);
      expect(row).toMatchObject({ decision: 'refused', status: 413, code: 'input-too-large', bounds: null });
      expect(row?.inputBytes).toBeGreaterThan(1024);
    });

    it('400 invalid-input with a pointer per problem', async () => {
      await configureProject({ accountIds: ['acc_1'] });

      const res = await call('get_account', { accountId: 7, extra: true });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({ type: 'urn:opsiforce:error:invalid-input', status: 400, operation: 'get_account' });
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ pointer: '', rule: 'additionalProperties' })])
      );
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 400,
        code: 'invalid-input',
        bounds: null,
        outputBytes: null,
      });
    });

    it('403 out-of-bounds with the bound, pointer, value and labelled allowed values', async () => {
      await configureProject({ accountIds: ['acc_1'], _labels: { accountIds: { acc_1: 'Acme' } } });

      const res = await call('get_account', { accountId: 'acc_9' });

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      const body = res.json();
      expect(body).toMatchObject({
        type: 'urn:opsiforce:error:out-of-bounds',
        status: 403,
        code: 'out-of-bounds',
        operation: 'get_account',
        bound: 'account',
        pointer: '/accountId',
        value: 'acc_9',
        allowed: [{ value: 'acc_1', label: 'Acme' }],
        truncated: false,
      });
      expect(await callRow(body.callId)).toMatchObject({
        decision: 'refused',
        status: 403,
        code: 'out-of-bounds',
        bounds: [{ bound: 'account', pointer: '/accountId', value: 'acc_9', label: 'acc_9' }],
        outputBytes: null,
      });
    });
  });
});
