import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfigurationCarry } from '../../src/external-services/configuration/project-configuration-carry';
import { Perms } from '../../src/permission/permission.constants';
import { SecretSealer } from '../../src/sealing/secret-sealer';
import { addMember, type MemberFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import {
  callOperation,
  configurePlatformService,
  dispatchToFakePod,
  gateCaller,
  mailboxIds,
  productionCaller,
  READY_FIXTURE_CRM,
  readProjectConfiguration,
  saveProjectConfiguration,
  storedProjectConfiguration,
  storeProjectConfiguration,
  type GateCallerFixture,
  type ServicePodFixture,
} from './support/gate';
import {
  environmentDatabase,
  INBOX_SERVICE,
  INBOX_SIGNING_KEY,
  inboundBuiltInsDir,
  providerEvent,
  sendWebhook,
} from './support/inbound';

describe('Publish (App) carrying Project configurations', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let development: GateCallerFixture;
  let production: GateCallerFixture;
  let member: MemberFixture;
  let serviceId: string;
  let sales: string;
  let service: ServicePodFixture;

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
    member = await addMember(app, development.tenant, [Perms.usePublicApi]);
    service = await dispatchToFakePod(app, FIXTURE_SERVICE);
  });

  afterEach(async () => {
    await service.stop();
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
      operations: { update_account: true, get_member: false },
      _labels: { accountIds: { acc_1: 'Acme' } },
    });

    const report = await carry();

    expect(report).toEqual([
      {
        kind: 'project-configuration',
        service: FIXTURE_SERVICE,
        displayName: 'Fixture CRM',
        outcome: 'carried',
        receiveTurnedOff: [],
      },
    ]);
    const developmentShown = await shownConfiguration(development.projectEnvironmentId);
    expect(await shownConfiguration(production.projectEnvironmentId)).toEqual(developmentShown);
    expect(developmentShown).toMatchObject({
      saved: true,
      values: { mailbox: sales, pipeline: 'sales', accountIds: ['acc_1'], signingSecret: { stored: true } },
      operations: { get_account: true, update_account: true, get_member: false, delete_account: false },
    });
  });

  it("runs the target's onProjectConfigurationSaved hook with the carried configuration", async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      pipeline: 'sales',
    });

    await carry();

    const hooks = service.pod.receivedHooks.filter((hook) => hook.hook === 'onProjectConfigurationSaved');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      caller: { environmentId: production.projectEnvironmentId, via: 'form' },
      previous: null,
      current: { mailbox: sales, pipeline: 'sales' },
    });
    expect(hooks[0]?.serviceConfiguration.mailboxes).toEqual([
      expect.objectContaining({ id: sales, label: 'Sales', token: 'sales-token' }),
    ]);
  });

  it('seals the carried secrets for the target, so its calls hand them to the service', async () => {
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      accountIds: ['acc_1'],
      signingSecret: 'project-signing-secret',
    });

    await carry();
    const res = await callOperation(app, {
      key: production.key,
      slug: FIXTURE_SERVICE,
      operation: 'get_account',
      input: { accountId: 'acc_1' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(service.pod.received.at(-1)?.projectConfiguration).toMatchObject({
      mailbox: sales,
      signingSecret: 'project-signing-secret',
    });
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
      operations: { delete_account: true },
    });
    await saveProjectConfiguration(app, FIXTURE_SERVICE, development.projectEnvironmentId, {
      mailbox: sales,
      accountsMode: 'all',
    });

    await carry();

    const carried = await readProjectConfiguration(app, FIXTURE_SERVICE, production.projectEnvironmentId);
    expect(carried.values).toEqual({ mailbox: sales, accountsMode: 'all' });
    expect(carried.operations.delete_account).toBe(false);
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

describe('Publish (App) handing inbound Events over to the target', () => {
  let storageRoot: string;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let development: GateCallerFixture;
  let production: GateCallerFixture;
  let address: string;

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'publish-carry-'));
    harness = await createExternalServicesTestApp({
      builtInsDir: inboundBuiltInsDir,
      env: { STORAGE_MOUNT_PATH: storageRoot },
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(INBOX_SERVICE);
    await configurePlatformService(app, INBOX_SERVICE, { signingKey: INBOX_SIGNING_KEY });
    development = await gateCaller(app);
    production = await productionCaller(app, development);
    address = `desk-${crypto.randomUUID()}`;
  });

  function carry() {
    return app.get(ProjectConfigurationCarry).carry(development.projectEnvironmentId, production.projectEnvironmentId);
  }

  function receiveOf(projectEnvironmentId: string) {
    return readProjectConfiguration(app, INBOX_SERVICE, projectEnvironmentId).then((read) => read.receive);
  }

  it('turns Receive off in Development for every type it carried, and says so', async () => {
    await saveProjectConfiguration(app, INBOX_SERVICE, development.projectEnvironmentId, {
      address,
      receive: { 'message.received': true, 'label.added': true },
    });

    const report = await carry();

    expect(report).toEqual([
      {
        kind: 'project-configuration',
        service: INBOX_SERVICE,
        displayName: 'Fixture Inbox',
        outcome: 'carried',
        receiveTurnedOff: ['message.received', 'label.added'],
      },
    ]);
    expect(await receiveOf(development.projectEnvironmentId)).toEqual({
      'message.received': false,
      'label.added': false,
      'member.posted': false,
    });
    expect(await receiveOf(production.projectEnvironmentId)).toEqual({
      'message.received': true,
      'label.added': true,
      'member.posted': false,
    });
    expect((await readProjectConfiguration(app, INBOX_SERVICE, development.projectEnvironmentId)).values).toEqual({
      address,
    });
  });

  it('stores the next Event only in the target', async () => {
    await saveProjectConfiguration(app, INBOX_SERVICE, development.projectEnvironmentId, {
      address,
      receive: { 'message.received': true },
    });

    await carry();
    const res = await sendWebhook(app, {
      events: [providerEvent({ type: 'message.received', key: 'm-1', data: { address, text: 'Hello' } })],
    });

    expect(res.statusCode).toBe(200);
    expect((await environmentDatabase(storageRoot, production.projectEnvironmentId)).events).toHaveLength(1);
    expect((await environmentDatabase(storageRoot, development.projectEnvironmentId)).events).toEqual([]);
  });

  it('keeps the target receiving on a later Publish while Development stays off', async () => {
    await saveProjectConfiguration(app, INBOX_SERVICE, development.projectEnvironmentId, {
      address,
      receive: { 'message.received': true },
    });
    await carry();

    const report = await carry();

    expect(report).toEqual([
      {
        kind: 'project-configuration',
        service: INBOX_SERVICE,
        displayName: 'Fixture Inbox',
        outcome: 'carried',
        receiveTurnedOff: [],
      },
    ]);
    expect((await receiveOf(production.projectEnvironmentId))['message.received']).toBe(true);
  });

  it('does nothing when the target is Development itself', async () => {
    await saveProjectConfiguration(app, INBOX_SERVICE, development.projectEnvironmentId, {
      address,
      receive: { 'message.received': true },
    });

    expect(
      await app.get(ProjectConfigurationCarry).carry(development.projectEnvironmentId, development.projectEnvironmentId)
    ).toEqual([]);
    expect((await receiveOf(development.projectEnvironmentId))['message.received']).toBe(true);
  });
});
