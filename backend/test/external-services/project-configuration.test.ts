import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigurationError } from '../../src/external-services/configuration/invalid-configuration.error';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  readProjectConfiguration,
  saveProjectConfiguration,
  storedProjectConfiguration,
  storeProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

describe('the Project configuration of a ProjectEnvironment', () => {
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

  function save(values: Record<string, unknown>) {
    return saveProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId, values);
  }

  it('starts a new configuration with reads on and writes and destructive Operations off', async () => {
    await save({ mailbox, accountsMode: 'all' });

    expect(await storedProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId)).toEqual({
      mailbox,
      accountsMode: 'all',
      operations: { get_account: true, get_member: true, update_account: false, delete_account: false },
      receive: {},
      _labels: {},
    });
  });

  it('reads the same switches before anything is saved', async () => {
    const read = await readProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId);

    expect(read).toMatchObject({
      saved: false,
      missing: ['mailbox'],
      operations: { get_account: true, get_member: true, update_account: false, delete_account: false },
    });
  });

  it('keeps stored switches across saves and changes only the ones sent', async () => {
    await save({ mailbox, operations: { get_member: false } });
    await save({ mailbox, operations: { delete_account: true } });

    const stored = await storedProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId);
    expect(stored?.operations).toEqual({
      get_account: true,
      get_member: false,
      update_account: false,
      delete_account: true,
    });
  });

  it('treats an Operation missing from a stored configuration as off, at the Gate too', async () => {
    await storeProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId, {
      mailbox,
      accountsMode: 'all',
      operations: { get_account: true },
    });

    const read = await readProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId);
    expect(read.operations).toEqual({
      get_account: true,
      get_member: false,
      update_account: false,
      delete_account: false,
    });
    const res = await callOperation(app, {
      key: caller.key,
      slug: FIXTURE_SERVICE,
      operation: 'get_member',
      input: { team: 'red', memberId: 'red_1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('operation-off');
  });

  it('refuses switches for undeclared Operations or Event types and malformed labels', async () => {
    const refusal = await save({
      mailbox,
      operations: { drop_everything: true, get_account: 'yes' },
      receive: { 'card.moved': true },
      _labels: { accountIds: { acc_1: 7 } },
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(InvalidConfigurationError);
    expect((refusal as InvalidConfigurationError).issues.map((issue) => issue.pointer)).toEqual([
      '/operations/drop_everything',
      '/operations/get_account',
      '/receive/card.moved',
      '/_labels',
    ]);
    expect(await storedProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId)).toBeNull();
  });

  it('validates the Project form values like the Service form and keeps labels', async () => {
    await expect(save({ mailbox, pipeline: 'marketing' })).rejects.toBeInstanceOf(InvalidConfigurationError);

    const saved = await save({
      mailbox,
      accountIds: ['acc_1'],
      _labels: { accountIds: { acc_1: 'Acme' } },
    });
    expect(saved).toMatchObject({
      saved: true,
      missing: [],
      values: { mailbox, accountIds: ['acc_1'] },
      labels: { accountIds: { acc_1: 'Acme' } },
    });
  });
});
