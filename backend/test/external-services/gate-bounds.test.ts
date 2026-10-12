import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  saveProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

describe('bounds through the Gate', () => {
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

  function configureProject(values: Record<string, unknown>) {
    return saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, { mailbox, ...values });
  }

  async function outcome(operation: string, input: unknown) {
    const res = await callOperation(app, { key: caller.key, slug: FIXTURE_SERVICE, operation, input });
    const body = res.json();
    return res.statusCode === 200 ? 'allowed' : `${res.statusCode} ${body.code} ${body.bound} ${body.pointer}`;
  }

  it('a scalar bound allows exactly the configured value', async () => {
    await configureProject({ accountsMode: 'all', pipeline: 'sales', operations: { update_account: true } });

    expect(await outcome('update_account', { accountId: 'acc_1', pipeline: 'sales', name: 'n' })).toBe('allowed');
    expect(await outcome('update_account', { accountId: 'acc_1', pipeline: 'support', name: 'n' })).toBe(
      '403 out-of-bounds pipeline /pipeline'
    );
  });

  it('an array bound allows any configured value and nothing else', async () => {
    await configureProject({ accountIds: ['acc_1', 'acc_3'] });

    expect(await outcome('get_account', { accountId: 'acc_1' })).toBe('allowed');
    expect(await outcome('get_account', { accountId: 'acc_3' })).toBe('allowed');
    expect(await outcome('get_account', { accountId: 'acc_2' })).toBe('403 out-of-bounds account /accountId');
  });

  it('an empty bound allows nothing', async () => {
    await configureProject({});

    expect(await outcome('get_account', { accountId: 'acc_1' })).toBe('403 out-of-bounds account /accountId');
  });

  it('unless opens the bound only when the configuration says so explicitly', async () => {
    await configureProject({ accountsMode: 'all' });

    expect(await outcome('get_account', { accountId: 'acc_2' })).toBe('allowed');
  });

  it('a list[].field bound allows the value from any item', async () => {
    await configureProject({ teams: [{ team: 'red', memberIds: ['red_1'] }] });

    expect(await outcome('get_member', { team: 'red', memberId: 'red_1' })).toBe('allowed');
    expect(await outcome('get_member', { team: 'blue', memberId: 'red_1' })).toBe('403 out-of-bounds team /team');
  });

  it('where narrows a list[].field bound to the item the input points at', async () => {
    await configureProject({
      teams: [
        { team: 'red', memberIds: ['red_1'] },
        { team: 'blue', memberIds: ['blue_1'] },
      ],
    });

    expect(await outcome('get_member', { team: 'blue', memberId: 'blue_1' })).toBe('allowed');
    expect(await outcome('get_member', { team: 'red', memberId: 'blue_1' })).toBe('403 out-of-bounds member /memberId');
  });
});
