import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigurationError } from '../../src/external-services/configuration/invalid-configuration.error';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  configurePlatformService,
  gateCaller,
  mailboxIds,
  READY_FIXTURE_CRM,
  readProjectConfiguration,
  saveProjectConfiguration,
  storedProjectConfiguration,
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

  it('stores a new configuration as its form values and labels, with no switches', async () => {
    await save({ mailbox, accountsMode: 'all' });

    expect(await storedProjectConfiguration(FIXTURE_SERVICE, caller.projectEnvironmentId)).toEqual({
      mailbox,
      accountsMode: 'all',
      _labels: {},
    });
  });

  it('reads what is missing before anything is saved', async () => {
    const read = await readProjectConfiguration(app, FIXTURE_SERVICE, caller.projectEnvironmentId);

    expect(read).toEqual({ saved: false, values: {}, missing: ['mailbox'], labels: {} });
  });

  it('refuses malformed labels', async () => {
    const refusal = await save({ mailbox, _labels: { accountIds: { acc_1: 7 } } }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(InvalidConfigurationError);
    expect((refusal as InvalidConfigurationError).issues.map((issue) => issue.pointer)).toEqual(['/_labels']);
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
