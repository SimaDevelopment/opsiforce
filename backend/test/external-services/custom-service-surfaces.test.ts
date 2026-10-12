import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServiceCalls } from '../../db/schema';
import { ProjectConfigurationCarry } from '../../src/external-services/configuration/project-configuration-carry';
import { ProjectConfigurationStore } from '../../src/external-services/configuration/project-configuration.store';
import { Perms } from '../../src/permission/permission.constants';
import { startFakeApp, type FakeApp } from './support/fake-app';
import { startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import { addMember } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder } from './support/custom-services';
import { deliveryCalls, podComesUp, ringDoorbells } from './support/doorbell';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import { callOperation, productionCaller, type GateCallerFixture } from './support/gate';
import { environmentDatabase } from './support/inbound';
import {
  BOARDS_MANIFEST,
  callableService,
  consumerIn,
  freePort,
  publishCustomService,
  READY_BOARDS,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';

const TENANT_SERVICES = '/api/external-services/services';

const FORMS_MANIFEST = {
  ...BOARDS_MANIFEST,
  serviceForm: [
    ...BOARDS_MANIFEST.serviceForm,
    { key: 'workspace', type: 'select', label: 'Workspace', options: { call: 'listWorkspaces' } },
  ],
  projectForm: [
    ...BOARDS_MANIFEST.projectForm,
    { key: 'boardSummary', type: 'info', label: 'Boards summary', call: 'boardSummary' },
  ],
};

describe('a published Custom External Service on the surfaces built for built-ins', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let fakeApp: FakeApp;
  let admin: PersonFixture;
  let service: PublishedService;
  let consumer: GateCallerFixture;
  let pod: FakeServicePod;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-surfaces-'));
    podPort = await freePort();
    fakeApp = await startFakeApp();
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot },
      config: { appPort: fakeApp.port },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_000,
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await fakeApp.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fakeApp.received.length = 0;
    fakeApp.answer(200);
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards', manifest: FORMS_MANIFEST });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    consumer = await consumerIn(app, admin.tenant);
    pod = await startFakeServicePod({ manifest: FORMS_MANIFEST, gatewayKey: service.key, port: podPort });
  });

  afterEach(async () => {
    await pod.close();
  });

  function serviceFormCall(
    route: string,
    name: string,
    payload: Record<string, unknown>,
    person: { headers: Record<string, string> } = admin
  ) {
    return app.inject({
      method: 'POST',
      url: `${TENANT_SERVICES}/${service.id}/${route}/${name}`,
      headers: person.headers,
      payload,
    });
  }

  describe('form calls', () => {
    it("answers the Organization admin's Service form call with the Organization's stored secrets", async () => {
      pod.scriptFormCall('options', 'listWorkspaces', () => [{ value: 'w1', label: 'Main' }]);

      const res = await serviceFormCall('options', 'listWorkspaces', { values: { apiToken: '' } });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual([{ value: 'w1', label: 'Main' }]);
      expect(pod.receivedFormCalls).toEqual([
        expect.objectContaining({
          route: 'options',
          name: 'listWorkspaces',
          form: 'serviceForm',
          serviceConfiguration: expect.objectContaining({ apiToken: READY_BOARDS.apiToken }),
        }),
      ]);
      expect(await formRowsOf(service.id)).toEqual([
        expect.objectContaining({
          externalServiceId: service.id,
          tenantId: admin.tenant.tenantId,
          decision: 'allowed',
          status: 200,
        }),
      ]);
    });

    it("refuses another Organization's admin, a member without the permission, and the operator route", async () => {
      const stranger = await tenantAdmin(app);
      const member = await addMember(app, admin.tenant, [Perms.usePublicApi]);

      expect((await serviceFormCall('options', 'listWorkspaces', { values: {} }, stranger)).statusCode).toBe(404);
      expect((await serviceFormCall('options', 'listWorkspaces', { values: {} }, member)).statusCode).toBe(403);
      expect(pod.receivedFormCalls).toEqual([]);
    });

    it("hands a consumer's Project form call the Organization's Service configuration", async () => {
      const configurer = await addMember(app, admin.tenant, [Perms.configureProjectExternalServices]);
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });

      const res = await app.inject({
        method: 'POST',
        url: `/api/external-services/projects/${consumer.projectId}/environments/${consumer.projectEnvironmentId}/services/${service.id}/info/boardSummary`,
        headers: configurer.headers,
        payload: { values: { boardIds: ['b2'] } },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(pod.receivedFormCalls).toEqual([
        expect.objectContaining({
          form: 'projectForm',
          values: expect.objectContaining({ boardIds: ['b2'] }),
          serviceConfiguration: expect.objectContaining({ apiToken: READY_BOARDS.apiToken }),
        }),
      ]);
    });
  });

  it("lists the service's Gate Calls on its Calls tab", async () => {
    await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
    const called = await callOperation(app, {
      key: consumer.key,
      slug: 'boards',
      operation: 'list_cards',
      input: { boardId: 'b1' },
    });
    expect(called.statusCode, called.body).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}/calls`,
      headers: admin.headers,
    });

    expect(res.statusCode, res.body).toBe(200);
    const calls = res.json().calls as { kind: string }[];
    expect(calls.filter((call) => call.kind === 'operation')).toEqual([
      expect.objectContaining({
        operation: 'list_cards',
        outcome: 'allowed',
        projectId: consumer.projectId,
      }),
    ]);
    expect(calls.filter((call) => call.kind === 'hook')).toEqual([
      expect.objectContaining({ operation: 'onServiceConfigurationSaved' }),
    ]);
  });

  it("carries a consumer's Development configuration of the service on Publish and hands Receive over", async () => {
    const production = await productionCaller(app, consumer);
    await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b2'], receive: { 'card.created': true } });

    const report = await app
      .get(ProjectConfigurationCarry)
      .carry(consumer.projectEnvironmentId, production.projectEnvironmentId);

    expect(report).toEqual([
      {
        kind: 'project-configuration',
        service: 'boards',
        displayName: 'Fixture Boards',
        outcome: 'carried',
        receiveTurnedOff: ['card.created'],
      },
    ]);
    const boards = await callableService(app, admin.tenant.tenantId, 'boards');
    expect(await app.get(ProjectConfigurationStore).read(boards, production.projectEnvironmentId)).toMatchObject({
      values: { boardIds: ['b2'] },
      receive: { 'card.created': true },
    });
  });

  it("rings the consumer App's doorbell for Events that came in through the service's own front door", async () => {
    await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'], receive: { 'card.created': true } });
    await podComesUp(app, consumer.projectEnvironmentId);
    pod.scriptInbound(() => ({
      events: [
        {
          type: 'card.created',
          key: 'card-rung',
          occurredAt: '2026-10-08T09:30:00.000Z',
          data: { boardId: 'b1', name: 'Ring me' },
        },
      ],
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-services/webhooks/${service.id}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode, res.body).toBe(200);
    await ringDoorbells(app);

    const { events } = await environmentDatabase(storageRoot, consumer.projectEnvironmentId);
    expect(events).toHaveLength(1);
    expect(fakeApp.received).toEqual([
      {
        path: '/api/external-services/boards',
        authorization: undefined,
        body: { service: 'boards', eventIds: [events[0]?.id] },
      },
    ]);
    expect(await deliveryCalls(consumer.projectEnvironmentId)).toEqual([
      expect.objectContaining({ kind: 'delivery', externalServiceId: service.id, status: 200 }),
    ]);
  });
});

function formRowsOf(externalServiceId: string) {
  return db
    .select()
    .from(externalServiceCalls)
    .where(and(eq(externalServiceCalls.externalServiceId, externalServiceId), eq(externalServiceCalls.kind, 'form')));
}
