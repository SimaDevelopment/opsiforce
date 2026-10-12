import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
} from './support/gate';

describe('ctx.state of a built-in service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('refuses every use: a built-in runs inside the platform, with no Project to keep it in', async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    const [mailbox] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM));
    const caller = await gateCaller(app);
    await saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, {
      mailbox,
      accountIds: ['acc_1'],
      operations: { delete_account: true },
    });

    const res = await callOperation(app, {
      key: caller.key,
      slug: FIXTURE_SERVICE,
      operation: 'delete_account',
      input: { accountId: 'acc_1' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      deleted: 'acc_1',
      stateRefusal: expect.stringMatching(/^ctx\.state is not available to built-in services/),
    });
  });
});
