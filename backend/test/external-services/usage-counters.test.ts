import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallLog } from '../../src/external-services/gate/call-log';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { thisMonth, usageRowsOf } from './support/call-log';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  dispatchToFakePod,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
  type ServicePodFixture,
} from './support/gate';

describe('Usage counters', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let caller: GateCallerFixture;
  let mailbox: string;
  let pod: ServicePodFixture | undefined;

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
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
      mailbox,
      accountsMode: 'all',
    });
  });

  afterEach(async () => {
    await pod?.stop();
    pod = undefined;
  });

  function call(operation: string, input: unknown) {
    return callOperation(app, { key: caller.key, slug: FIXTURE_SERVICE, operation, input });
  }

  it('counts every Operation call in the month’s bucket, refused and failed ones also on their own', async () => {
    expect((await call('get_account', { accountId: 'acc_1' })).statusCode).toBe(200);
    expect((await call('get_account', { accountId: 'acc_2' })).statusCode).toBe(200);
    expect((await call('delete_account', { accountId: 'acc_1' })).statusCode).toBe(403);
    pod = await dispatchToFakePod(app, FIXTURE_SERVICE);
    pod.pod.crash('get_account');
    expect((await call('get_account', { accountId: 'acc_1' })).statusCode).toBe(502);

    expect(await usageRowsOf(caller.projectEnvironmentId)).toEqual([
      expect.objectContaining({
        tenantId: caller.tenant.tenantId,
        projectId: caller.projectId,
        projectEnvironmentId: caller.projectEnvironmentId,
        service: FIXTURE_SERVICE,
        month: thisMonth(),
        calls: 4,
        refused: 1,
        failed: 1,
        events: 0,
      }),
    ]);
  });

  it('counts nothing for a caller the Gate could not identify', async () => {
    const res = await callOperation(app, { key: 'gw-not-a-key', slug: FIXTURE_SERVICE, operation: 'get_account' });

    expect(res.statusCode).toBe(401);
    expect(await usageRowsOf(caller.projectEnvironmentId)).toEqual([]);
  });

  it('never counts form calls, hooks, deliveries or inbound requests as calls', async () => {
    const serviceId = await builtInServiceId(FIXTURE_SERVICE);
    for (const kind of ['form', 'hook', 'delivery', 'inbound'] as const) {
      await app.get(CallLog).record({
        id: crypto.randomUUID(),
        kind,
        slug: FIXTURE_SERVICE,
        externalServiceId: serviceId,
        tenantId: caller.tenant.tenantId,
        projectId: caller.projectId,
        projectTitle: caller.projectTitle,
        projectEnvironmentId: caller.projectEnvironmentId,
        operation: 'listAccounts',
        decision: 'allowed',
        status: 500,
        durationMs: 4,
      });
    }

    expect(await usageRowsOf(caller.projectEnvironmentId)).toEqual([]);
  });
});
