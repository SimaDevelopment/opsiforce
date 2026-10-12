import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceCalls } from '../../db/schema';
import { callTokenFor } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  askGate,
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  productionCaller,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

interface ListedCall {
  callId: string;
  operation: string;
  status: number;
  code: string | null;
  createdAt: string;
}

describe('/calls: the calling environment’s Calls to a service', () => {
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

  async function configured(environment: GateCallerFixture): Promise<GateCallerFixture> {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, environment.projectEnvironmentId, {
      mailbox,
      accountsMode: 'all',
    });
    return environment;
  }

  function call(environment: GateCallerFixture, operation: string, input: unknown) {
    return callOperation(app, { key: environment.key, slug: FIXTURE_SERVICE, operation, input });
  }

  function listCalls(key: string | null, query = '') {
    return askGate(app, { key: key ?? undefined, path: `${FIXTURE_SERVICE}/calls${query}` });
  }

  it('lists this environment’s Calls newest first, without bodies', async () => {
    await configured(caller);
    await call(caller, 'get_account', { accountId: 'acc_1' });
    const refused = await call(caller, 'delete_account', { accountId: 'acc_1' });
    await call(caller, 'get_member', { team: 'red', memberId: 'red_1' });

    const res = await listCalls(caller.key);

    expect(res.statusCode, res.body).toBe(200);
    const { calls } = res.json<{ calls: ListedCall[] }>();
    expect(calls.map(({ operation, status }) => [operation, status])).toEqual([
      ['get_member', 403],
      ['delete_account', 403],
      ['get_account', 200],
    ]);
    expect(calls[1]).toEqual({
      callId: refused.json().callId,
      kind: 'operation',
      via: 'agent',
      operation: 'delete_account',
      operationKind: 'destructive',
      decision: 'refused',
      status: 403,
      code: 'operation-off',
      detail: expect.stringContaining('delete_account'),
      bounds: null,
      inputBytes: Buffer.byteLength(JSON.stringify({ accountId: 'acc_1' })),
      outputBytes: null,
      durationMs: expect.any(Number),
      manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(res.body).not.toContain('acc_1"}');
  });

  it('never shows another environment’s or another Project’s Calls', async () => {
    const production = await configured(await productionCaller(app, caller));
    const otherProject = await configured(await gateCaller(app));
    await configured(caller);
    await call(caller, 'get_account', { accountId: 'acc_1' });
    await call(production, 'get_member', { team: 'blue', memberId: 'blue_1' });
    await call(otherProject, 'delete_account', { accountId: 'acc_2' });

    const development = (await listCalls(caller.key)).json<{ calls: ListedCall[] }>().calls;
    const live = (await listCalls(production.key)).json<{ calls: ListedCall[] }>().calls;

    expect(development.map(({ operation }) => operation)).toEqual(['get_account']);
    expect(live.map(({ operation }) => operation)).toEqual(['get_member']);
  });

  it('leaves out Calls to another service', async () => {
    await configured(caller);
    await call(caller, 'get_account', { accountId: 'acc_1' });
    await db.insert(externalServiceCalls).values({
      id: crypto.randomUUID(),
      kind: 'operation',
      via: 'agent',
      slug: 'another-service',
      projectEnvironmentId: caller.projectEnvironmentId,
      decision: 'refused',
      status: 404,
      code: 'unknown-service',
      durationMs: 1,
    });

    const { calls } = (await listCalls(caller.key)).json<{ calls: ListedCall[] }>();

    expect(calls.map(({ operation }) => operation)).toEqual(['get_account']);
  });

  describe('limit', () => {
    async function stageCalls(count: number): Promise<void> {
      const serviceId = await builtInServiceId(FIXTURE_SERVICE);
      const start = Date.now() - count * 1000;
      await db.insert(externalServiceCalls).values(
        Array.from({ length: count }, (_, index) => ({
          id: crypto.randomUUID(),
          kind: 'operation' as const,
          via: 'app' as const,
          externalServiceId: serviceId,
          slug: FIXTURE_SERVICE,
          projectEnvironmentId: caller.projectEnvironmentId,
          operation: `call_${index}`,
          decision: 'allowed' as const,
          status: 200,
          durationMs: 1,
          createdAt: new Date(start + index * 1000),
        }))
      );
    }

    it('returns the 50 newest by default', async () => {
      await stageCalls(55);

      const { calls } = (await listCalls(caller.key)).json<{ calls: ListedCall[] }>();

      expect(calls).toHaveLength(50);
      expect(calls[0]?.operation).toBe('call_54');
      expect(calls[49]?.operation).toBe('call_5');
    });

    it('returns the newest `limit` Calls', async () => {
      await stageCalls(5);

      const { calls } = (await listCalls(caller.key, '?limit=2')).json<{ calls: ListedCall[] }>();

      expect(calls.map(({ operation }) => operation)).toEqual(['call_4', 'call_3']);
    });

    it.each(['0', '201', 'ten', '1.5'])('refuses limit=%s', async (limit) => {
      const res = await listCalls(caller.key, `?limit=${limit}`);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid-limit' });
    });
  });

  it('still answers while the platform has not set the service up', async () => {
    await configured(caller);
    await call(caller, 'get_account', { accountId: 'acc_1' });
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    await call(caller, 'get_account', { accountId: 'acc_1' });

    const res = await listCalls(caller.key);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ calls: ListedCall[] }>().calls.map(({ status, code }) => [status, code])).toEqual([
      [503, 'service-not-configured'],
      [200, null],
    ]);
  });

  describe('refused', () => {
    it('without a service key', async () => {
      const res = await listCalls(null);

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('unauthorized');
    });

    it('with a call token in place of the environment service key', async () => {
      const res = await listCalls(callTokenFor(app, caller.tenant, caller.projectId));

      expect(res.statusCode).toBe(401);
    });

    it('for a service that does not exist', async () => {
      const res = await askGate(app, { key: caller.key, path: 'no-such-service/calls' });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('unknown-service');
    });
  });
});
