import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { callTokenFor } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  askGate,
  callRowsOf,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  productionCaller,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

const PROBLEM_JSON = 'application/problem+json; charset=utf-8';

describe('describe: what a consumer may do with a service here', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let caller: GateCallerFixture;
  let support: string;
  let sales: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    [support, sales] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [
      string,
      string,
    ];
    caller = await gateCaller(app);
  });

  function configure(values: Record<string, unknown>, environment = caller) {
    return saveProjectConfiguration(app, FIXTURE_SERVICE, environment.projectEnvironmentId, values);
  }

  function describeService(key: string | null = caller.key) {
    return askGate(app, { key: key ?? undefined, path: FIXTURE_SERVICE });
  }

  it('lists every Operation with its kind and whether it is on here', async () => {
    await configure({ mailbox: support, operations: { update_account: true } });

    const res = await describeService();

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().operations).toEqual({
      get_account: { kind: 'read', on: true },
      update_account: { kind: 'write', title: 'Update account', on: true },
      delete_account: { kind: 'destructive', on: false },
      get_member: { kind: 'read', on: true },
    });
  });

  it('shows the Project configuration with every chosen value labelled and no secret', async () => {
    await configure({
      mailbox: sales,
      pipeline: 'support',
      accountIds: ['acc_1', 'acc_9'],
      signingSecret: 'project-signing-secret',
      teams: [{ team: 'red', memberIds: ['red_1'] }],
      _labels: { accountIds: { acc_1: 'Acme' }, memberIds: { red_1: 'First red member' } },
    });

    const res = await describeService();

    expect(res.statusCode, res.body).toBe(200);
    const { projectConfiguration } = res.json();
    expect(projectConfiguration).toMatchObject({
      mailbox: sales,
      pipeline: 'support',
      accountIds: ['acc_1', 'acc_9'],
      signingSecret: { stored: true },
      teams: [{ team: 'red', memberIds: ['red_1'] }],
      _labels: {
        mailbox: { [sales]: 'Sales' },
        pipeline: { support: 'Support' },
        accountIds: { acc_1: 'Acme' },
        team: { red: 'Red team' },
        memberIds: { red_1: 'First red member' },
      },
    });
    for (const secret of ['project-signing-secret', 'crm-key-1', 'support-token', 'sales-token']) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('renders the info templates from this configuration and the platform one', async () => {
    await configure({ mailbox: support, pipeline: 'sales' });

    const res = await describeService();

    expect(res.json().info).toEqual({ inboxAddress: 'sales@eu.inbox.test' });
  });

  it('renders an info template blank while any value it names is blank, so a half address never shows', async () => {
    await configure({ mailbox: support });

    const res = await describeService();

    expect(res.json().info).toEqual({ inboxAddress: '' });
  });

  it('says the configuration is complete only when nothing required is missing', async () => {
    const before = await describeService();

    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({ complete: false, missing: ['mailbox'] });
    expect(before.json().operations.update_account.on).toBe(false);

    await configure({ mailbox: support });
    const after = await describeService();

    expect(after.json()).toMatchObject({ complete: true, missing: [] });
  });

  it('answers for the environment whose key calls: a Development chat sees Development', async () => {
    const production = await productionCaller(app, caller);
    await configure({ mailbox: support, pipeline: 'sales', operations: { update_account: true } });
    await configure({ mailbox: sales, pipeline: 'support' }, production);

    const development = (await describeService(caller.key)).json();
    const live = (await describeService(production.key)).json();

    expect(development).toMatchObject({
      environment: { slug: 'dev', name: 'Development' },
      projectConfiguration: { mailbox: support, pipeline: 'sales' },
      operations: { update_account: { on: true } },
    });
    expect(live).toMatchObject({
      environment: { slug: 'prod', name: 'Production' },
      projectConfiguration: { mailbox: sales, pipeline: 'support' },
      operations: { update_account: { on: false } },
    });
  });

  describe('refused', () => {
    it('without a service key', async () => {
      const res = await describeService(null);

      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toBe(PROBLEM_JSON);
      expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:unauthorized', code: 'unauthorized' });
    });

    it('with a call token in place of the environment service key', async () => {
      const res = await describeService(callTokenFor(app, caller.tenant, caller.projectId));

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('unauthorized');
    });

    it('with a revoked key', async () => {
      await app.get(GatewayKeyService).revokeKeys(caller.projectId);

      const res = await describeService();

      expect(res.statusCode).toBe(401);
    });

    it('for a service that does not exist', async () => {
      const res = await askGate(app, { key: caller.key, path: 'no-such-service' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'unknown-service', service: 'no-such-service' });
    });

    it('for a service the platform has not set up', async () => {
      await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);

      const res = await describeService();

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'service-not-configured', service: FIXTURE_SERVICE });
    });
  });

  it('writes no Call row', async () => {
    await configure({ mailbox: support });

    await describeService();

    expect(await callRowsOf(caller.projectEnvironmentId)).toEqual([]);
  });
});
