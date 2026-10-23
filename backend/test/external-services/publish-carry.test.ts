import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigurationCarry } from '../../src/external-services/configuration/project-configuration-carry';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { addMember, type MemberFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  configurePlatformService,
  gateCaller,
  mailboxIds,
  productionCaller,
  READY_FIXTURE_CRM,
  readProjectConfiguration,
  saveProjectConfiguration,
  storedProjectConfiguration,
  storeProjectConfiguration,
  type GateCallerFixture,
} from './support/gate';

interface RecordedHook {
  projectEnvironmentId: string;
  previous: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  mailboxes: Record<string, unknown>[];
}

function recordedHooks(): RecordedHook[] {
  return ((globalThis as Record<symbol, unknown>)[Symbol.for('opsiforce.test.fixture-crm.hooks')] ??=
    []) as RecordedHook[];
}

describe('Publish (App) carrying Project configurations', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let development: GateCallerFixture;
  let production: GateCallerFixture;
  let member: MemberFixture;
  let serviceId: string;
  let sales: string;

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
    [, sales] = mailboxIds(await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM)) as [string, string];
    development = await gateCaller(app);
    production = await productionCaller(app, development);
    member = await addMember(app, development.tenant, ['can_use_public_api']);
    recordedHooks().length = 0;
  });

  function carry() {
    return app.get(ProjectConfigurationCarry).carry(development.projectEnvironmentId, production.projectEnvironmentId);
  }

  async function shownConfiguration(projectEnvironmentId: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/external-services/projects/${development.projectId}/environments/${projectEnvironmentId}/services/${serviceId}`,
      headers: member.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().projectConfiguration;
  }

  it('gives the target the same Project configuration as Development and reports it', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      pipeline: 'sales',
      accountIds: ['acc_1'],
      teams: [{ team: 'red', memberIds: ['m_1'] }],
      signingSecret: 'project-signing-secret',
      _labels: { accountIds: { acc_1: 'Acme' } },
    });

    const report = await carry();

    expect(report).toEqual([
      {
        kind: 'project-configuration',
        service: FIXTURE_SERVICE,
        displayName: 'Fixture CRM',
        outcome: 'carried',
      },
    ]);
    const developmentShown = await shownConfiguration(development.projectEnvironmentId);
    expect(await shownConfiguration(production.projectEnvironmentId)).toEqual(developmentShown);
    expect(developmentShown).toMatchObject({
      saved: true,
      values: { mailbox: sales, pipeline: 'sales', accountIds: ['acc_1'], signingSecret: { stored: true } },
    });
  });

  it("runs the target's onProjectConfigurationSaved hook with the carried configuration", async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      pipeline: 'sales',
    });

    await carry();

    const hooks = recordedHooks().filter((hook) => hook.projectEnvironmentId === production.projectEnvironmentId);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ previous: null, current: { mailbox: sales, pipeline: 'sales' } });
    expect(hooks[0]?.mailboxes).toContainEqual(
      expect.objectContaining({ id: sales, label: 'Sales', token: 'sales-token' })
    );
  });

  it('seals the carried secrets for the target, so the service gets them opened there', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      accountIds: ['acc_1'],
      signingSecret: 'project-signing-secret',
    });

    await carry();

    expect(
      recordedHooks().find((hook) => hook.projectEnvironmentId === production.projectEnvironmentId)?.current
    ).toMatchObject({ mailbox: sales, signingSecret: 'project-signing-secret' });
    const stored = await storedProjectConfiguration(FIXTURE_SERVICE, production.projectEnvironmentId);
    expect(() =>
      app
        .get(SecretSealer)
        .open(
          stored?.signingSecret ?? null,
          `${serviceId}|environment:${development.projectEnvironmentId}|signingSecret`
        )
    ).toThrow();
  });

  it('overwrites what the target held for the service', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId, {
      mailbox: sales,
      pipeline: 'support',
      accountIds: ['acc_9'],
      signingSecret: 'old-production-secret',
    });
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      accountsMode: 'all',
    });

    await carry();

    const carried = await readProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId);
    expect(carried.values).toEqual({ mailbox: sales, accountsMode: 'all' });
  });

  it('leaves a target configuration alone when Development has none for that service', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId, {
      mailbox: sales,
      accountIds: ['acc_9'],
    });

    expect(await carry()).toEqual([]);
    expect(
      (await readProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId)).values
    ).toMatchObject({ accountIds: ['acc_9'] });
  });

  it('reports a configuration whose secret cannot be opened and leaves the target untouched', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId, {
      mailbox: sales,
      accountIds: ['acc_9'],
    });
    await storeProjectConfiguration(FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      accountIds: ['acc_1'],
      signingSecret: app.get(SecretSealer).seal('copied', `${serviceId}|environment:elsewhere|signingSecret`),
    } as never);

    expect(await carry()).toEqual([
      {
        kind: 'project-configuration',
        service: FIXTURE_SERVICE,
        displayName: 'Fixture CRM',
        outcome: 'failed',
        code: 'secret-unreadable',
      },
    ]);
    expect(
      (await readProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId)).values
    ).toMatchObject({ accountIds: ['acc_9'] });
  });
});
