import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, gte } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError } from '@opsiforce/external-service-sdk';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  externalServiceCalls,
  externalServiceConfigs,
  externalServiceProjectConfigs,
  skills,
} from '../../db/schema';
import { SKILL_DELIVERY_QUEUE } from '../../src/delivery/delivery.types';
import { CallLog } from '../../src/external-services/gate/call-log';
import { Perms } from '../../src/permission/permission.constants';
import { PodService } from '../../src/pod/pod.service';
import { ProjectController } from '../../src/project/project.controller';
import { ProjectService } from '../../src/project/project.service';
import { AppReadinessService } from '../../src/project/app-readiness.service';
import { seedLiveAgent } from '../support/agent-fixtures';
import { startFakeServicePod, type FakeServicePod } from './support/fake-service-pod';
import type { FakePodService, FakeQueue } from '../support/infra-fakes';
import { addMember } from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import {
  builderProjectRow,
  createCustomService,
  customServiceRow,
  ensureExternalServiceBuilder,
  TENANT_SERVICES,
  postCustomService,
} from './support/custom-services';
import { memberWithout, tenantAdmin, platformOperator, type PersonFixture } from './support/fixtures';
import { callOperation, productionCaller, type GateCallerFixture } from './support/gate';
import {
  BOARDS_MANIFEST,
  consumerIn,
  freePort,
  publishCustomService,
  READY_BOARDS,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  serviceEnvironmentRow,
  suspendServicePod,
  type PublishedService,
} from './support/published-services';
import {
  createTestProject,
  DEVELOPMENT_BOARDS,
  DEVELOPMENT_MANIFEST,
  runningDevelopment,
  saveDevelopmentConfiguration,
  saveTestProjectConfiguration,
} from './support/test-lane';

async function projectConfigurationRowsOf(serviceId: string) {
  return db
    .select({
      projectEnvironmentId: externalServiceProjectConfigs.projectEnvironmentId,
      values: externalServiceProjectConfigs.values,
    })
    .from(externalServiceProjectConfigs)
    .where(eq(externalServiceProjectConfigs.externalServiceId, serviceId));
}

const PUBLIC_URL = 'https://opsiforce.example.com';

@Module({ controllers: [ProjectController] })
class ProjectRoutes {}
const START_HOLD_MS = 2_000;

describe('disabling and enabling a Custom External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let consumer: GateCallerFixture;
  let pod: FakeServicePod;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-lifecycle-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: START_HOLD_MS,
      extraModules: [ProjectRoutes],
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    expect(saved.statusCode, saved.body).toBe(200);
    consumer = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
    pod = await startFakeServicePod({ manifest: BOARDS_MANIFEST, gatewayKey: service.key, port: podPort });
  });

  afterEach(async () => {
    await pod.close();
  });

  function pods(): FakePodService {
    return app.get(PodService) as unknown as FakePodService;
  }

  function listCards() {
    return callOperation(app, { key: consumer.key, slug: 'boards', operation: 'list_cards', input: { boardId: 'b1' } });
  }

  function lifecycle(action: 'disable' | 'enable', person: PersonFixture = admin, id = service.id) {
    return app.inject({ method: 'POST', url: `${TENANT_SERVICES}/${id}/${action}`, headers: person.headers });
  }

  async function builderChatLifecycle(action: 'disable' | 'enable') {
    const projectAdmin = await addMember(app, admin.tenant, [Perms.manageTenantExternalServices, Perms.disableProject]);
    return app.inject({
      method: 'POST',
      url: `/api/projects/${service.builderChatId}/${action}`,
      headers: projectAdmin.headers,
    });
  }

  function skillDeliveriesQueuedDuring(change: () => Promise<unknown>): Promise<string[]> {
    const queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
    const before = queue.callsTo('add').length;
    return change().then(() =>
      queue
        .callsTo('add')
        .slice(before)
        .map((call) => (call.args as { data: { projectEnvironmentId: string } }).data.projectEnvironmentId)
    );
  }

  async function projectServiceIds(): Promise<string[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/external-services/projects/${consumer.projectId}/environments/${consumer.projectEnvironmentId}/services`,
      headers: admin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ services: { id: string }[] }>().services.map((entry) => entry.id);
  }

  it('stops the pods, answers service-disabled and hides the service from Project forms, keeping its configuration', async () => {
    const res = await lifecycle('disable');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ id: service.id, slug: 'boards', disabled: true });
    expect((await builderProjectRow(service.builderChatId))?.disabled).toBe(true);
    expect(
      pods()
        .callsTo('deletePod')
        .map((call) => call.args.podName)
    ).toContain(pods().assignedPodName(service.projectEnvironmentId));

    const call = await listCards();
    expect(call.statusCode).toBe(503);
    expect(call.json()).toMatchObject({ code: 'service-disabled' });
    expect(pod.requests).toEqual([]);

    const inbound = await app.inject({
      method: 'POST',
      url: `/api/external-services/webhooks/${service.id}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(inbound.statusCode).toBe(503);

    expect(await projectServiceIds()).not.toContain(service.id);

    expect(await projectConfigurationRowsOf(service.id)).toEqual([
      {
        projectEnvironmentId: consumer.projectEnvironmentId,
        values: expect.objectContaining({ boardIds: ['b1'] }),
      },
    ]);
    const view = await app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}`,
      headers: admin.headers,
    });
    expect(view.json()).toMatchObject({ disabled: true, available: true });
  });

  it('answers the same when the service is already disabled', async () => {
    await lifecycle('disable');

    const again = await lifecycle('disable');

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ disabled: true });
  });

  it('restores calls on Enable', async () => {
    await lifecycle('disable');
    const podName = pods().assignedPodName(service.projectEnvironmentId);
    const startupsBefore = pods()
      .callsTo('waitForReady')
      .filter((call) => call.args.podName === podName).length;

    const res = await lifecycle('enable');

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ disabled: false });
    await waitFor(
      () =>
        pods()
          .callsTo('waitForReady')
          .filter((call) => call.args.podName === podName).length > startupsBefore
    );
    pods().markPodReady(podName, '127.0.0.1');
    await waitFor(async () => (await serviceEnvironmentRow(service.projectEnvironmentId))?.status === 'active');
    app.get(AppReadinessService).markServing(service.projectEnvironmentId);

    const call = await listCards();
    expect(call.statusCode, call.body).toBe(200);
    expect(pod.received).toHaveLength(1);
    expect(await projectServiceIds()).toContain(service.id);
  });

  it.each([
    ['the service page', (action: 'disable' | 'enable') => lifecycle(action), 200],
    ["the builder chat's Project routes", builderChatLifecycle, 201],
  ])('delivers the Service skill again to its consumers on Disable and Enable from %s', async (_, change, status) => {
    const disabling = await skillDeliveriesQueuedDuring(async () => {
      const res = await change('disable');
      expect(res.statusCode, res.body).toBe(status);
    });

    expect(disabling).toContain(consumer.projectEnvironmentId);
    expect((await builderProjectRow(service.builderChatId))?.disabled).toBe(true);
    const call = await listCards();
    expect(call.statusCode).toBe(503);
    expect(call.json()).toMatchObject({ code: 'service-disabled' });
    expect(await projectServiceIds()).not.toContain(service.id);

    const enabling = await skillDeliveriesQueuedDuring(async () => {
      const res = await change('enable');
      expect(res.statusCode, res.body).toBe(status);
    });

    expect(enabling).toContain(consumer.projectEnvironmentId);
    expect((await builderProjectRow(service.builderChatId))?.disabled).toBe(false);
    expect(await projectServiceIds()).toContain(service.id);
  });

  it('is only for Organization admins of the service', async () => {
    const outsider = await tenantAdmin(app);
    const member = await memberWithout(app);
    const operator = await platformOperator(app);

    expect((await lifecycle('disable', outsider)).statusCode).toBe(404);
    expect((await lifecycle('disable', member)).statusCode).toBe(403);
    expect((await lifecycle('disable', operator)).statusCode).toBe(403);
    expect((await builderProjectRow(service.builderChatId))?.disabled).toBe(false);
  });
});

describe('deleting a Custom External Service', () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let service: PublishedService;
  let roadmap: GateCallerFixture;
  let operations: GateCallerFixture;
  let pod: FakeServicePod;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-delete-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: START_HOLD_MS,
      extraModules: [ProjectRoutes],
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
    pod = await startFakeServicePod({ manifest: BOARDS_MANIFEST, gatewayKey: service.key, port: podPort });
    await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS);
    roadmap = await consumerIn(app, admin.tenant);
    operations = await consumerIn(app, admin.tenant);
    await saveConsumerConfiguration(app, roadmap, 'boards', { boardIds: ['b1'] });
    await saveConsumerConfiguration(app, operations, 'boards', { boardIds: ['b2'] });
    pod.receivedHooks.length = 0;
  });

  afterEach(async () => {
    await pod.close();
  });

  function goodbyes() {
    return pod.receivedHooks.map(({ hook, caller, previous, current }) => ({
      hook,
      projectEnvironmentId: caller?.environmentId,
      previous,
      current,
    }));
  }

  function consumersOf(person = admin) {
    return app.inject({
      method: 'GET',
      url: `${TENANT_SERVICES}/${service.id}/consumers`,
      headers: person.headers,
    });
  }

  function deleteService(confirmSlug: string | undefined, person = admin) {
    const query = confirmSlug === undefined ? '' : `?confirmSlug=${encodeURIComponent(confirmSlug)}`;
    return app.inject({
      method: 'DELETE',
      url: `${TENANT_SERVICES}/${service.id}${query}`,
      headers: person.headers,
    });
  }

  function listCards(caller: GateCallerFixture, boardId: string) {
    return callOperation(app, { key: caller.key, slug: 'boards', operation: 'list_cards', input: { boardId } });
  }

  async function knownToAnAgent(serviceId: string): Promise<void> {
    const agent = await seedLiveAgent(admin.tenant.tenantId, admin.userId);
    const [profile] = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agent.id));
    if (!profile) throw new Error(`Agent ${agent.id} has no profile`);
    const [skill] = await db
      .select({ id: skills.id, latestVersionId: skills.latestVersionId })
      .from(skills)
      .where(eq(skills.externalServiceId, serviceId));
    if (!skill?.latestVersionId) throw new Error(`Service ${serviceId} has no Service skill`);
    await db
      .insert(agentProfileSkills)
      .values({ profileId: profile.id, skillId: skill.id, skillVersionId: skill.latestVersionId });
  }

  async function rowCountsOf(serviceId: string) {
    const [configs, serviceSkills, profileEntries] = await Promise.all([
      db.select().from(externalServiceConfigs).where(eq(externalServiceConfigs.externalServiceId, serviceId)),
      db.select().from(skills).where(eq(skills.externalServiceId, serviceId)),
      db
        .select()
        .from(agentProfileSkills)
        .innerJoin(skills, eq(skills.id, agentProfileSkills.skillId))
        .where(eq(skills.externalServiceId, serviceId)),
    ]);
    return {
      serviceConfigurations: configs.length,
      projectConfigurationRows: (await projectConfigurationRowsOf(serviceId)).length,
      serviceSkills: serviceSkills.length,
      profileEntries: profileEntries.length,
    };
  }

  it('lists every consuming ProjectEnvironment', async () => {
    const res = await consumersOf();

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(res.json()).toEqual(
      expect.arrayContaining([
        {
          projectId: roadmap.projectId,
          projectTitle: roadmap.projectTitle,
          projectEnvironmentId: roadmap.projectEnvironmentId,
          environmentName: 'Development',
        },
        {
          projectId: operations.projectId,
          projectTitle: operations.projectTitle,
          projectEnvironmentId: operations.projectEnvironmentId,
          environmentName: 'Development',
        },
      ])
    );
  });

  it.each([
    ['without the typed slug', undefined],
    ['with a different slug', 'board'],
  ])('refuses %s and keeps everything', async (_case, confirmSlug) => {
    const res = await deleteService(confirmSlug);

    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ type: 'urn:opsiforce:error:slug-mismatch', status: 400 });
    expect(await customServiceRow(service.id)).toBeDefined();
    expect(pod.receivedHooks).toEqual([]);
  });

  it('runs every consumer hook, then removes the service and its configurations', async () => {
    pod.script('list_cards', () => ({ cards: [] }));
    const call = await listCards(roadmap, 'b1');
    expect(call.statusCode, call.body).toBe(200);
    await db.insert(externalServiceConfigs).values({
      id: crypto.randomUUID(),
      externalServiceId: service.id,
      tenantId: admin.tenant.tenantId,
      environment: 'development',
      values: {},
    });
    await knownToAnAgent(service.id);
    expect(await rowCountsOf(service.id)).toEqual({
      serviceConfigurations: 2,
      projectConfigurationRows: 2,
      serviceSkills: 1,
      profileEntries: 1,
    });

    const res = await deleteService('boards');

    expect(res.statusCode, res.body).toBe(204);
    expect(goodbyes()).toHaveLength(2);
    expect(goodbyes()).toEqual(
      expect.arrayContaining([
        {
          hook: 'onProjectConfigurationSaved',
          projectEnvironmentId: roadmap.projectEnvironmentId,
          previous: expect.objectContaining({ boardIds: ['b1'] }),
          current: null,
        },
        {
          hook: 'onProjectConfigurationSaved',
          projectEnvironmentId: operations.projectEnvironmentId,
          previous: expect.objectContaining({ boardIds: ['b2'] }),
          current: null,
        },
      ])
    );
    expect(await customServiceRow(service.id)).toBeUndefined();
    expect(await builderProjectRow(service.builderChatId)).toBeUndefined();
    expect(await rowCountsOf(service.id)).toEqual({
      serviceConfigurations: 0,
      projectConfigurationRows: 0,
      serviceSkills: 0,
      profileEntries: 0,
    });
    const kept = await db
      .select()
      .from(externalServiceCalls)
      .where(eq(externalServiceCalls.projectEnvironmentId, roadmap.projectEnvironmentId));
    expect(kept.map(({ kind, operation }) => [kind, operation])).toEqual(
      expect.arrayContaining([
        ['operation', 'list_cards'],
        ['hook', 'onProjectConfigurationSaved'],
      ])
    );
    expect(kept.filter((row) => row.externalServiceId !== null)).toEqual([]);
    expect(kept).toEqual(kept.map(() => expect.objectContaining({ slug: 'boards', tenantId: admin.tenant.tenantId })));
  });

  it('answers unknown-service afterwards and frees the slug', async () => {
    expect((await deleteService('boards')).statusCode).toBe(204);

    const call = await listCards(roadmap, 'b1');
    expect(call.statusCode).toBe(404);
    expect(call.json()).toMatchObject({ code: 'unknown-service' });
    const inbound = await app.inject({
      method: 'POST',
      url: `/api/external-services/webhooks/${service.id}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(inbound.statusCode).toBe(404);
    expect((await consumersOf()).statusCode).toBe(404);

    const again = await postCustomService(app, admin, { name: 'Boards again', slug: 'boards' });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('keeps a goodbye hook Call that lands after the service row is gone', async () => {
    expect((await deleteService('boards')).statusCode).toBe(204);
    const lateCallId = crypto.randomUUID();

    await app.get(CallLog).record({
      id: lateCallId,
      kind: 'hook',
      via: null,
      externalServiceId: service.id,
      slug: 'boards',
      operation: 'onProjectConfigurationSaved',
      decision: 'allowed',
      status: 200,
      durationMs: 10_000,
      tenantId: admin.tenant.tenantId,
      projectId: roadmap.projectId,
      projectEnvironmentId: roadmap.projectEnvironmentId,
    });

    const [late] = await db.select().from(externalServiceCalls).where(eq(externalServiceCalls.id, lateCallId));
    expect(late).toMatchObject({ externalServiceId: null, slug: 'boards', kind: 'hook', status: 200 });
  });

  it('waits once for a pod that does not start, not once per consumer', async () => {
    await pod.close();
    await suspendServicePod(service.projectEnvironmentId);
    const deletedFrom = new Date();

    const res = await deleteService('boards');

    expect(res.statusCode, res.body).toBe(204);
    const hookCalls = await db
      .select()
      .from(externalServiceCalls)
      .where(
        and(
          eq(externalServiceCalls.tenantId, admin.tenant.tenantId),
          eq(externalServiceCalls.kind, 'hook'),
          gte(externalServiceCalls.createdAt, deletedFrom)
        )
      );
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]).toMatchObject({ code: 'service-starting' });
  });

  it('deletes even when a consumer hook fails', async () => {
    pod.scriptHook('onProjectConfigurationSaved', () => {
      throw new ServiceError({ status: 502, code: 'upstream-unavailable', detail: 'The board tool is down.' });
    });

    const res = await deleteService('boards');

    expect(res.statusCode, res.body).toBe(204);
    expect(pod.receivedHooks).toHaveLength(2);
    expect(await customServiceRow(service.id)).toBeUndefined();
  });

  it('deletes a disabled service', async () => {
    await app.inject({ method: 'POST', url: `${TENANT_SERVICES}/${service.id}/disable`, headers: admin.headers });

    const res = await deleteService('boards');

    expect(res.statusCode, res.body).toBe(204);
    expect(await customServiceRow(service.id)).toBeUndefined();
  });

  async function developmentWithTestProject(builderChatId: string, serviceId: string) {
    const development = await runningDevelopment(app, storageRoot, builderChatId);
    await pod.close();
    pod = await startFakeServicePod({
      manifest: DEVELOPMENT_MANIFEST,
      gatewayKey: development.key,
      port: podPort,
    });
    expect((await saveDevelopmentConfiguration(app, admin, serviceId, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
    const testProject = await createTestProject(app, development.key);
    expect((await saveTestProjectConfiguration(app, development.key, { boardIds: ['b2'] })).statusCode).toBe(200);
    pod.receivedHooks.length = 0;
    return testProject;
  }

  it('says goodbye when a consuming Project is deleted', async () => {
    await app.get(ProjectService).remove(roadmap.projectId, admin.tenant.tenantId);

    expect(goodbyes()).toEqual([
      {
        hook: 'onProjectConfigurationSaved',
        projectEnvironmentId: roadmap.projectEnvironmentId,
        previous: expect.objectContaining({ boardIds: ['b1'] }),
        current: null,
      },
    ]);
  });

  it('says goodbye when a consuming environment is deleted', async () => {
    const production = await productionCaller(app, operations);
    await saveConsumerConfiguration(app, production, 'boards', { boardIds: ['b1'] });
    pod.receivedHooks.length = 0;

    await app
      .get(ProjectService)
      .removeEnvironment(operations.projectId, production.projectEnvironmentId, admin.tenant.tenantId);

    expect(goodbyes()).toEqual([
      {
        hook: 'onProjectConfigurationSaved',
        projectEnvironmentId: production.projectEnvironmentId,
        previous: expect.objectContaining({ boardIds: ['b1'] }),
        current: null,
      },
    ]);
  });

  it("says goodbye to a draft's Test Project through Development", async () => {
    const draft = await createCustomService(app, admin, 'Draft boards', `draft-${crypto.randomUUID().slice(0, 6)}`);
    const testProject = await developmentWithTestProject(draft.builderChatId, draft.id);

    const res = await app.inject({
      method: 'DELETE',
      url: `${TENANT_SERVICES}/${draft.id}?confirmSlug=${draft.slug}`,
      headers: admin.headers,
    });

    expect(res.statusCode, res.body).toBe(204);
    expect(goodbyes()).toEqual([
      {
        hook: 'onProjectConfigurationSaved',
        projectEnvironmentId: testProject.projectEnvironmentId,
        previous: expect.objectContaining({ boardIds: ['b2'] }),
        current: null,
      },
    ]);
  });

  it("sends the Test Project's goodbye to Development, not to the published service", async () => {
    const testProject = await developmentWithTestProject(service.builderChatId, service.id);

    expect((await deleteService('boards')).statusCode).toBe(204);

    expect(goodbyes()).toEqual([
      {
        hook: 'onProjectConfigurationSaved',
        projectEnvironmentId: testProject.projectEnvironmentId,
        previous: expect.objectContaining({ boardIds: ['b2'] }),
        current: null,
      },
    ]);
  });

  it('sends no goodbyes to a disabled service', async () => {
    await app.inject({ method: 'POST', url: `${TENANT_SERVICES}/${service.id}/disable`, headers: admin.headers });

    expect((await deleteService('boards')).statusCode).toBe(204);

    const hookCalls = await db
      .select()
      .from(externalServiceCalls)
      .where(eq(externalServiceCalls.projectEnvironmentId, roadmap.projectEnvironmentId));
    expect(hookCalls.filter((row) => row.kind === 'hook' && row.status === 503)).toEqual([]);
  });

  it("refuses the Project routes' Delete of its builder chat and of the chat's environments", async () => {
    const projectAdmin = await addMember(app, admin.tenant, [
      Perms.manageTenantExternalServices,
      Perms.deleteProject,
      Perms.deleteEnvironment,
    ]);

    const chat = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${service.builderChatId}`,
      headers: projectAdmin.headers,
    });
    const environment = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${service.builderChatId}/environments/${service.projectEnvironmentId}`,
      headers: projectAdmin.headers,
    });

    expect(chat.statusCode, chat.body).toBe(409);
    expect(chat.json()).toMatchObject({ code: 'manage-from-service-page' });
    expect(environment.statusCode, environment.body).toBe(409);
    expect(environment.json()).toMatchObject({
      code: 'manage-from-service-page',
      message: expect.stringContaining('keeps its environments'),
    });
    expect(await builderProjectRow(service.builderChatId)).toBeDefined();
    expect(await serviceEnvironmentRow(service.projectEnvironmentId)).toBeDefined();
    expect(goodbyes()).toEqual([]);
  });

  it('is only for Organization admins of the service', async () => {
    const outsider = await tenantAdmin(app);
    const member = await memberWithout(app);

    expect((await deleteService('boards', outsider)).statusCode).toBe(404);
    expect((await consumersOf(outsider)).statusCode).toBe(404);
    expect((await deleteService('boards', member)).statusCode).toBe(403);
    expect((await consumersOf(member)).statusCode).toBe(403);
    expect(await customServiceRow(service.id)).toBeDefined();
  });
});

describe("deleting a service whose Test Project's Development is asleep", () => {
  const WAKE_HOLD_MS = 20_000;
  const WAKE_TAKES_MS = 11_000;
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let pod: FakeServicePod | undefined;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'custom-delete-asleep-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: WAKE_HOLD_MS,
      extraModules: [ProjectRoutes],
    });
    app = harness.app;
    await harness.listen();
  });

  afterAll(async () => {
    await pod?.close();
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('wakes the pod before the goodbye hook starts its 10 s', async () => {
    const admin = await tenantAdmin(app);
    const draft = await createCustomService(app, admin, 'Draft boards', `draft-${crypto.randomUUID().slice(0, 6)}`);
    const development = await runningDevelopment(app, storageRoot, draft.builderChatId);
    pod = await startFakeServicePod({ manifest: DEVELOPMENT_MANIFEST, gatewayKey: development.key, port: podPort });
    expect((await saveDevelopmentConfiguration(app, admin, draft.id, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
    const testProject = await createTestProject(app, development.key);
    expect((await saveTestProjectConfiguration(app, development.key, { boardIds: ['b2'] })).statusCode).toBe(200);
    await pod.close();
    await suspendServicePod(development.projectEnvironmentId);
    const pods = app.get(PodService) as unknown as FakePodService;
    const podName = pods.assignedPodName(development.projectEnvironmentId);

    const deleted = app.inject({
      method: 'DELETE',
      url: `${TENANT_SERVICES}/${draft.id}?confirmSlug=${draft.slug}`,
      headers: admin.headers,
    });
    await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
    await new Promise((resolve) => setTimeout(resolve, WAKE_TAKES_MS));
    pod = await startFakeServicePod({ manifest: DEVELOPMENT_MANIFEST, gatewayKey: development.key, port: podPort });
    pods.markPodReady(podName, '127.0.0.1');
    await waitFor(async () => (await serviceEnvironmentRow(development.projectEnvironmentId))?.status !== 'suspended');
    app.get(AppReadinessService).markServing(development.projectEnvironmentId);

    expect((await deleted).statusCode).toBe(204);
    expect(
      pod.receivedHooks.map(({ hook, caller, current }) => ({ hook, environmentId: caller?.environmentId, current }))
    ).toEqual([
      { hook: 'onProjectConfigurationSaved', environmentId: testProject.projectEnvironmentId, current: null },
    ]);
  });
});
