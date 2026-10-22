import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createFileServiceState } from '@opsiforce/external-service-sdk/server';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getQueueToken } from '@nestjs/bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agents, externalServices, skills, users } from '../../db/schema';
import { AgentProfileService } from '../../src/agent/agent-profile.service';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { SKILL_DELIVERY_QUEUE, SKILLS_DIR } from '../../src/delivery/delivery.types';
import { ServiceSkillReach } from '../../src/external-services/knowledge/service-skill-reach';
import { ServiceDefaultEnvironments } from '../../src/external-services/publishing/service-default-environments';
import { ServiceRegistry } from '../../src/external-services/registry/service-registry';
import { ProjectService } from '../../src/project/project.service';
import { Perms } from '../../src/permission/permission.constants';
import { ensureBuiltInAgent } from '../support/agent-fixtures';
import type { FakeQueue } from '../support/infra-fakes';
import { waitFor } from '../support/wait-for';
import { addMember, createProject } from '../support/project-fixtures';
import { createUserRow } from '../support/org-fixtures';
import { SecretSealer, SecretUnreadableError } from '../../src/sealing/secret-sealer';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder, renameSlug } from './support/custom-services';
import { memberWithout, tenantAdmin, type PersonFixture } from './support/fixtures';
import { callThroughGate, gatewayUrlOf, resolveCaller } from './support/gate-proxy';
import type { GateCallerFixture } from './support/gate';
import { environmentDatabase } from './support/inbound';
import {
  addServiceEnvironment,
  BOARDS_MANIFEST,
  consumerIn,
  freePort,
  productionEnvironmentOf,
  publishCustomService,
  READY_BOARDS,
  saveConsumerConfiguration,
  saveCustomServiceConfiguration,
  writeServiceFiles,
  type PublishedService,
} from './support/published-services';
import {
  environmentStateFile,
  startSdk2ServicePod,
  type Sdk2PodHandlers,
  type Sdk2ServicePod,
} from './support/sdk2-service-pod';
import {
  builderLane,
  createTestProject,
  developmentRoute,
  DEVELOPMENT_BOARDS,
  DEVELOPMENT_MANIFEST,
  runningDevelopment,
  saveDevelopmentConfiguration,
  saveTestProjectConfiguration,
  storedServiceConfiguration,
  storeServiceConfigurationRaw,
  type BuilderDevelopment,
  writeDevelopmentSkill,
  type CreatedTestProject,
} from './support/test-lane';

async function serviceSkillOf(serviceId: string) {
  const [skill] = await db.select().from(skills).where(eq(skills.externalServiceId, serviceId));
  if (!skill) throw new Error(`Service ${serviceId} has no Service skill`);
  return skill;
}

const PUBLIC_URL = 'https://opsiforce.example.com';

const DEVELOPMENT_SKILL = '---\nname: boards\ndescription: Boards, as built.\n---\n\nDevelopment knows the cards.\n';

const PUBLISHED_SKILL = '---\nname: boards\ndescription: Boards.\n---\n\nThe published boards.\n';

const SIGNING_MANIFEST = {
  ...DEVELOPMENT_MANIFEST,
  projectForm: [
    ...DEVELOPMENT_MANIFEST.projectForm,
    { key: 'signingKey', type: 'secret', label: 'Signing key', generate: { bytes: 16 } },
  ],
};

async function stateKeys(stateFile: string): Promise<string[]> {
  return (await createFileServiceState(stateFile).list()).map((entry) => entry.key);
}

describe("the External Service Builder's test lane", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let podPort: number;
  let admin: PersonFixture;
  let gatewayUrl: string;
  let pods: Sdk2ServicePod[];

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'test-lane-'));
    podPort = await freePort();
    harness = await createExternalServicesTestApp({
      env: { OPSIFORCE_PUBLIC_URL: PUBLIC_URL, STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: podPort,
      serviceStartHoldMs: 1_000,
    });
    app = harness.app;
    gatewayUrl = gatewayUrlOf(await harness.listen());
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pods = [];
    admin = await tenantAdmin(app);
  });

  afterEach(async () => {
    for (const pod of pods) await pod.close();
  });

  async function podWith(
    key: string,
    manifest: unknown,
    options: { stateFile?: string; handlers?: Sdk2PodHandlers } = {}
  ): Promise<Sdk2ServicePod> {
    const pod = await startSdk2ServicePod({ manifest, gatewayKey: key, gatewayUrl, port: podPort, ...options });
    pods.push(pod);
    return pod;
  }

  function call(key: string, slug: string, path = '/boards/cards') {
    return callThroughGate(app, { credential: `Bearer ${key}`, slug }, path);
  }

  async function stopPods(): Promise<void> {
    for (const pod of pods.splice(0)) await pod.close();
  }

  function serviceSkillFile(projectEnvironmentId: string): string {
    return join(storageRoot, 'projects', projectEnvironmentId, SKILLS_DIR, 'service-boards', 'SKILL.md');
  }

  describe('the builder reading its own service', () => {
    it('answers the slug and name live, so a slug changed before the first Publish reaches the builder', async () => {
      const created = await createCustomService(app, admin, 'Trello for Ops', 'ops-boards');
      const development = await runningDevelopment(app, storageRoot, created.builderChatId);

      const before = await builderLane(app, development.key, {});
      expect(before.statusCode, before.body).toBe(200);
      expect(before.json()).toMatchObject({
        service: { id: created.id, slug: 'ops-boards', name: 'Trello for Ops', published: false, disabled: false },
        development: {
          webhookUrl: `${PUBLIC_URL}/api/external-services/webhooks/${created.id}/development`,
          servable: true,
          serviceConfiguration: { saved: false, missing: ['apiToken'] },
        },
        testProject: null,
      });

      expect((await renameSlug(app, admin, created.id, 'ops-cards')).statusCode).toBe(200);
      expect((await builderLane(app, development.key, {})).json().service.slug).toBe('ops-cards');
    });

    it('refuses any key but the builder chat Development key', async () => {
      const service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      const consumer = await consumerIn(app, admin.tenant);

      const anonymous = await builderLane(app, null, {});
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['content-type']).toContain('application/problem+json');

      for (const key of [consumer.key, service.key]) {
        const refused = await builderLane(app, key, {});
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json()).toMatchObject({ code: 'not-a-builder-chat' });
      }
    });
  });

  describe("Development's own Service configuration", () => {
    let service: PublishedService;
    let running: BuilderDevelopment;

    beforeEach(async () => {
      service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      running = await runningDevelopment(app, storageRoot, service.builderChatId);
    });

    function opens(sealed: unknown, place: string): unknown {
      return app.get(SecretSealer).open((sealed ?? null) as never, place);
    }

    it('starts empty and saves apart from the configuration callers use', async () => {
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);

      const empty = await developmentRoute(app, admin, service.id, {});
      expect(empty.statusCode, empty.body).toBe(200);
      expect(empty.json()).toMatchObject({
        id: service.id,
        description: DEVELOPMENT_MANIFEST.description,
        webhookUrl: `${PUBLIC_URL}/api/external-services/webhooks/${service.id}/development`,
        serviceConfiguration: { missing: ['apiToken'] },
        saved: false,
        production: { saved: true },
      });

      const saved = await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_BOARDS);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({
        serviceConfiguration: { values: { apiToken: { stored: true } }, missing: [] },
        saved: true,
      });
      const tenantId = admin.tenant.tenantId;
      const development = await storedServiceConfiguration(service.id, 'development');
      expect(opens(development?.apiToken, `${service.id}|${tenantId}+development|apiToken`)).toBe(
        DEVELOPMENT_BOARDS.apiToken
      );
      const production = await storedServiceConfiguration(service.id, null);
      expect(opens(production?.apiToken, `${service.id}|${tenantId}|apiToken`)).toBe(READY_BOARDS.apiToken);
    });

    it('copies from Production only on request, sealing every secret again at Development', async () => {
      const nothing = await developmentRoute(app, admin, service.id, {
        method: 'POST',
        path: '/configuration/copy-from-production',
      });
      expect(nothing.statusCode).toBe(409);
      expect(nothing.json()).toMatchObject({ code: 'nothing-to-copy' });

      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      const copied = await developmentRoute(app, admin, service.id, {
        method: 'POST',
        path: '/configuration/copy-from-production',
      });

      expect(copied.statusCode, copied.body).toBe(200);
      expect(copied.json()).toMatchObject({ serviceConfiguration: { missing: [] }, saved: true });
      const tenantId = admin.tenant.tenantId;
      const development = await storedServiceConfiguration(service.id, 'development');
      expect(opens(development?.apiToken, `${service.id}|${tenantId}+development|apiToken`)).toBe(
        READY_BOARDS.apiToken
      );
      expect(opens(development?.apiSecret, `${service.id}|${tenantId}+development|apiSecret`)).toBe(
        READY_BOARDS.apiSecret
      );
      expect(() => opens(development?.apiToken, `${service.id}|${tenantId}|apiToken`)).toThrow(SecretUnreadableError);
    });

    it('runs onServiceConfigurationSaved for a Copy from Production like any save', async () => {
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      const pod = await podWith(running.key, DEVELOPMENT_MANIFEST);

      const copied = await developmentRoute(app, admin, service.id, {
        method: 'POST',
        path: '/configuration/copy-from-production',
      });

      expect(copied.statusCode, copied.body).toBe(200);
      expect(copied.json().hookFailure).toBeNull();
      expect(pod.hooks).toEqual([
        expect.objectContaining({ hook: 'onServiceConfigurationSaved', previous: null, current: READY_BOARDS }),
      ]);
    });

    it('keeps a save whose hook fails, shows the failure and re-runs the hook on Retry', async () => {
      let hooksSeen = 0;
      let failing = true;
      await podWith(running.key, DEVELOPMENT_MANIFEST, {
        handlers: {
          hooks: {
            onServiceConfigurationSaved: () => {
              hooksSeen += 1;
              if (failing) throw new Error('The board tool is down.');
            },
          },
        },
      });

      const saved = await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_BOARDS);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().hookFailure).toMatchObject({ code: 'service-failed' });
      expect((await developmentRoute(app, admin, service.id, {})).json().hookFailure).toMatchObject({
        code: 'service-failed',
      });

      failing = false;
      const retried = await developmentRoute(app, admin, service.id, {
        method: 'POST',
        path: '/configuration/hook/retry',
      });

      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().hookFailure).toBeNull();
      expect(hooksSeen).toBe(2);
    });

    it('never opens a Development blob in Production', async () => {
      expect((await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
      const development = await storedServiceConfiguration(service.id, 'development');
      await storeServiceConfigurationRaw(service.id, admin.tenant.tenantId, null, development ?? {});
      const consumer = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
      const pod = await podWith(service.key, BOARDS_MANIFEST);

      const res = await call(consumer.key, 'boards');

      expect(res.status).toBe(502);
      expect(res.headers.get('opsiforce-outcome')).toBe('failed');
      expect(pod.received).toEqual([]);
    });

    it('belongs to Organization admins of the service', async () => {
      const outsider = await tenantAdmin(app);
      expect((await developmentRoute(app, outsider, service.id, {})).statusCode).toBe(404);
      const member = await memberWithout(app);
      expect((await developmentRoute(app, member, service.id, {})).statusCode).toBe(403);
    });
  });

  describe('the Test Project', () => {
    it('is created once per builder chat and named in the builder view', async () => {
      const created = await createCustomService(app, admin, 'Boards', 'boards');
      const development = await runningDevelopment(app, storageRoot, created.builderChatId);

      const testProject = await createTestProject(app, development.key);

      const again = await builderLane(app, development.key, { method: 'POST', path: '/test-project', payload: {} });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'test-project-exists', testProjectId: testProject.id });
      expect((await builderLane(app, development.key, {})).json().testProject).toMatchObject({
        id: testProject.id,
        projectEnvironmentId: testProject.projectEnvironmentId,
      });
    });
  });

  describe('the Test Project configuration', () => {
    it('generates the secret when the Test Project is configured and never reveals it on a later save', async () => {
      const created = await createCustomService(app, admin, 'Boards', 'boards');
      const development = await runningDevelopment(app, storageRoot, created.builderChatId, SIGNING_MANIFEST);
      await createTestProject(app, development.key);
      const receiving = { boardIds: ['b1'] };

      const first = await saveTestProjectConfiguration(app, development.key, receiving);

      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().revealed).toEqual([]);
      expect(first.json().projectConfiguration.values.signingKey).toEqual({ stored: true });
      const again = await saveTestProjectConfiguration(app, development.key, {
        ...receiving,
        signingKey: { stored: true },
      });
      expect(again.json().revealed).toEqual([]);
    });
  });

  describe('routing', () => {
    let service: PublishedService;
    let development: BuilderDevelopment;
    let testProject: CreatedTestProject;
    let consumer: GateCallerFixture;

    beforeEach(async () => {
      service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      development = await runningDevelopment(app, storageRoot, service.builderChatId);
      const saved = await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_BOARDS);
      expect(saved.statusCode, saved.body).toBe(200);
      testProject = await createTestProject(app, development.key);
      const configured = await saveTestProjectConfiguration(app, development.key, { boardIds: ['b2'] });
      expect(configured.statusCode, configured.body).toBe(200);
      consumer = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, consumer, 'boards', { boardIds: ['b1'] });
    });

    it("sends the Test Project's calls to Development with Development's own Service configuration", async () => {
      const pod = await podWith(development.key, DEVELOPMENT_MANIFEST);

      const res = await call(testProject.key, 'boards');

      expect(res.status).toBe(200);
      expect(pod.received[0]).toMatchObject({
        caller: { projectEnvironmentId: testProject.projectEnvironmentId },
        serviceConfiguration: DEVELOPMENT_BOARDS,
        projectConfiguration: { boardIds: ['b2'] },
      });
    });

    it('sends every other caller to the Default environment with the configuration callers use', async () => {
      const pod = await podWith(service.key, BOARDS_MANIFEST);

      const res = await call(consumer.key, 'boards');

      expect(res.status).toBe(200);
      expect(pod.received[0]).toMatchObject({
        caller: { projectEnvironmentId: consumer.projectEnvironmentId },
        serviceConfiguration: READY_BOARDS,
      });
    });

    it("lets the builder run its Test Project's form calls, to turn the names in a brief into ids", async () => {
      const picking = {
        ...DEVELOPMENT_MANIFEST,
        projectForm: [
          { key: 'boardIds', type: 'multiselect', label: 'Boards', options: { call: 'listBoards', searchable: true } },
        ],
      };
      await writeServiceFiles(storageRoot, development.directory, picking, {
        modifiedAt: new Date(Date.now() + 60_000),
      });
      const seen: unknown[] = [];
      await podWith(development.key, picking, {
        handlers: {
          options: {
            listBoards: (draft, ctx) => {
              seen.push({ form: draft.form, query: draft.query, caller: ctx.caller });
              return [{ value: 'b2', label: 'Operations' }];
            },
          },
        },
      });

      const picked = await builderLane(app, development.key, {
        method: 'POST',
        path: '/probe/options/listBoards',
        payload: { query: 'oper', values: {} },
      });
      const unknown = await builderLane(app, development.key, { method: 'POST', path: '/probe/widgets/listBoards' });

      expect(picked.statusCode, picked.body).toBe(200);
      expect(picked.json()).toEqual([{ value: 'b2', label: 'Operations' }]);
      expect(seen).toEqual([
        {
          form: 'projectForm',
          query: 'oper',
          caller: expect.objectContaining({ projectEnvironmentId: testProject.projectEnvironmentId }),
        },
      ]);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'unknown-form-call' });
    });

    it("reaches a draft's Development before the first Publish, while everyone else gets 404", async () => {
      await stopPods();
      const draft = await createCustomService(app, admin, 'Cards', 'cards');
      const draftDevelopment = await runningDevelopment(app, storageRoot, draft.builderChatId);
      expect((await saveDevelopmentConfiguration(app, admin, draft.id, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
      const draftTest = await createTestProject(app, draftDevelopment.key);
      expect((await saveTestProjectConfiguration(app, draftDevelopment.key, { boardIds: ['b1'] })).statusCode).toBe(
        200
      );
      await podWith(draftDevelopment.key, DEVELOPMENT_MANIFEST);

      const reached = await call(draftTest.key, 'cards');
      expect(reached.status).toBe(200);

      const unknown = await resolveCaller(app, { credential: `Bearer ${consumer.key}`, slug: 'cards' });
      expect(unknown.statusCode).toBe(404);
    });
    it('configures the service under test on Update once Development can be served, and delivers its skill', async () => {
      const draft = await createCustomService(app, admin, 'Lanes', `lanes-${crypto.randomUUID().slice(0, 6)}`);
      const draftDevelopment = await runningDevelopment(app, storageRoot, draft.builderChatId, { sdk: 2 });
      const draftTest = await createTestProject(app, draftDevelopment.key);
      const delivery = app.get(DeliveryService);
      expect(await delivery.serviceSkillsFor(draftTest.projectEnvironmentId)).toEqual([]);

      await writeServiceFiles(storageRoot, draftDevelopment.directory, DEVELOPMENT_MANIFEST);
      const res = await builderLane(app, draftDevelopment.key, { method: 'POST', path: '/test-project/update' });

      expect(res.statusCode, res.body).toBe(204);
      expect((await delivery.serviceSkillsFor(draftTest.projectEnvironmentId)).map((skill) => skill.name)).toEqual([
        `service-${draft.slug}`,
      ]);
    });

    it("keeps a draft's sealed secrets readable after its slug is renamed", async () => {
      await stopPods();
      const draft = await createCustomService(app, admin, 'Lanes', `lanes-${crypto.randomUUID().slice(0, 6)}`);
      const draftDevelopment = await runningDevelopment(app, storageRoot, draft.builderChatId);
      expect((await saveDevelopmentConfiguration(app, admin, draft.id, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
      const draftTest = await createTestProject(app, draftDevelopment.key);
      expect((await saveTestProjectConfiguration(app, draftDevelopment.key, { boardIds: ['b1'] })).statusCode).toBe(
        200
      );
      const renamed = `${draft.slug}-renamed`;
      expect((await renameSlug(app, admin, draft.id, renamed)).statusCode).toBe(200);
      const pod = await podWith(draftDevelopment.key, DEVELOPMENT_MANIFEST);

      const res = await call(draftTest.key, renamed);

      expect(res.status).toBe(200);
      expect(pod.received.at(-1)?.serviceConfiguration).toEqual(DEVELOPMENT_BOARDS);
    });
  });

  describe("Development's Update and Reset", () => {
    let service: PublishedService;
    let development: BuilderDevelopment;
    let testProject: CreatedTestProject;
    let consumer: GateCallerFixture;

    const RECEIVING = { boardIds: ['b1'] };

    beforeEach(async () => {
      service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      development = await runningDevelopment(app, storageRoot, service.builderChatId);
      await writeDevelopmentSkill(storageRoot, development.directory, DEVELOPMENT_SKILL);
      expect((await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
      testProject = await createTestProject(app, development.key);
      expect((await saveTestProjectConfiguration(app, development.key, RECEIVING)).statusCode).toBe(200);
      consumer = await consumerIn(app, admin.tenant);
      await saveConsumerConfiguration(app, consumer, 'boards', RECEIVING);
    });

    it("resets the Test Project: its Events cleared, Development's webhooks deregistered and registered afresh on wiped state", async () => {
      const developmentState = environmentStateFile(storageRoot, development.directory);
      const defaultState = environmentStateFile(storageRoot, service.directory);
      const pod = await podWith(development.key, DEVELOPMENT_MANIFEST, { stateFile: developmentState });
      expect((await saveDevelopmentConfiguration(app, admin, service.id, DEVELOPMENT_BOARDS)).statusCode).toBe(200);
      expect((await saveTestProjectConfiguration(app, development.key, RECEIVING)).statusCode).toBe(200);
      expect(pod.hooks.at(-1)).toMatchObject({
        hook: 'onProjectConfigurationSaved',
        current: { boardIds: ['b1'] },
      });
      expect(
        await pod.service.deliver(
          { type: 'card.created', key: 'c-1', occurredAt: '2026-10-08T09:30:00.000Z', data: { boardId: 'b1' } },
          { to: [testProject.projectEnvironmentId] }
        )
      ).toEqual([{ projectEnvironmentId: testProject.projectEnvironmentId, result: 'stored' }]);
      await pod.service.state.set('registration', 'wh-1');
      expect(await stateKeys(developmentState)).toEqual(['registration']);
      await createFileServiceState(defaultState).set('published-key', 1);
      const hooksBefore = pod.hooks.length;

      const res = await builderLane(app, development.key, { method: 'POST', path: '/test-project/reset' });

      expect(res.statusCode, res.body).toBe(204);
      expect((await environmentDatabase(storageRoot, testProject.projectEnvironmentId)).events).toEqual([]);
      expect(existsSync(developmentState)).toBe(false);
      expect(await stateKeys(defaultState)).toEqual(['published-key']);
      expect(pod.hooks.slice(hooksBefore)).toEqual([
        expect.objectContaining({
          hook: 'onProjectConfigurationSaved',
          caller: expect.objectContaining({ projectEnvironmentId: testProject.projectEnvironmentId }),
          previous: expect.objectContaining({ boardIds: ['b1'] }),
          current: null,
          serviceConfiguration: DEVELOPMENT_BOARDS,
        }),
        expect.objectContaining({
          hook: 'onServiceConfigurationSaved',
          previous: DEVELOPMENT_BOARDS,
          current: null,
          serviceConfiguration: DEVELOPMENT_BOARDS,
        }),
        expect.objectContaining({
          hook: 'onServiceConfigurationSaved',
          previous: null,
          current: DEVELOPMENT_BOARDS,
          serviceConfiguration: DEVELOPMENT_BOARDS,
        }),
      ]);
    });

    it("gives the Test Project Development's Service skill, and Update delivers it again", async () => {
      const delivered = await readFile(serviceSkillFile(testProject.projectEnvironmentId), 'utf8');
      expect(delivered).toContain('name: service-boards');
      expect(delivered).toContain('Development knows the cards.');

      await writeDevelopmentSkill(storageRoot, development.directory, `${DEVELOPMENT_SKILL}\nAnd now the lists.\n`);
      expect(await app.get(ServiceSkillReach).staleEnvironments()).not.toContain(testProject.projectEnvironmentId);
      const queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
      const before = queue.callsTo('add').length;

      const res = await builderLane(app, development.key, { method: 'POST', path: '/test-project/update' });

      expect(res.statusCode, res.body).toBe(204);
      expect(queue.callsTo('add').slice(before)).toContainEqual(
        expect.objectContaining({
          args: expect.objectContaining({
            data: expect.objectContaining({ projectEnvironmentId: testProject.projectEnvironmentId }),
          }),
        })
      );
      const [skill] = await app.get(DeliveryService).serviceSkillsFor(testProject.projectEnvironmentId);
      expect((await skill?.tree())?.[0]?.content.toString()).toContain('And now the lists.');
    });

    it('lists the service under test in the Test Project chat bar as enabled and connected', async () => {
      const member = await addMember(app, admin.tenant, [
        Perms.manageTenantExternalServices,
        Perms.configureProjectExternalServices,
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/external-services/projects/${testProject.id}/environments/${testProject.projectEnvironmentId}/services`,
        headers: member.headers,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().services).toContainEqual(
        expect.objectContaining({
          id: service.id,
          description: DEVELOPMENT_MANIFEST.description,
          state: 'enabled',
          configuration: { saved: true, missing: [] },
        })
      );
    });
  });

  describe('a published service an Agent carries', () => {
    async function carryServiceSkill(agentId: string, serviceId: string): Promise<void> {
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      await app
        .get(AgentProfileService)
        .setSkill(
          { ...agent, disabled: false },
          { tenantId: admin.tenant.tenantId, userId: admin.userId, canManageAgents: true },
          (await serviceSkillOf(serviceId)).id,
          {}
        );
    }

    async function republish(service: { builderChatId: string; projectEnvironmentId: string }): Promise<void> {
      await app.get(ServiceDefaultEnvironments).publishedTo(service.builderChatId, service.projectEnvironmentId);
    }

    it('is a Skill of the Organization in the Store, laid from its Default environment, and a republish lays a new version', async () => {
      const service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      await writeDevelopmentSkill(storageRoot, service.directory, PUBLISHED_SKILL);
      await republish(service);
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      const appBuilder = await ensureBuiltInAgent('app-builder');
      await carryServiceSkill(appBuilder, service.id);
      const first = await serviceSkillOf(service.id);
      expect(first).toMatchObject({ name: 'service-boards', origin: 'custom', tenantId: admin.tenant.tenantId });

      const projectId = await createProject(app, admin.tenant, { agentId: appBuilder });

      const delivered = await readFile(serviceSkillFile(projectId), 'utf8');
      expect(delivered).toContain('name: service-boards');
      expect(delivered).toContain('The published boards.');
      expect(await app.get(ServiceSkillReach).staleEnvironments()).not.toContain(projectId);
      const queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
      const before = queue.callsTo('add').length;

      await writeDevelopmentSkill(storageRoot, service.directory, `${PUBLISHED_SKILL}\nNow with lists.\n`);
      await republish(service);

      expect((await serviceSkillOf(service.id)).latestVersionId).not.toBe(first.latestVersionId);
      expect(
        queue
          .callsTo('add')
          .slice(before)
          .map((call) => (call.args as { data: { projectEnvironmentId: string } }).data.projectEnvironmentId)
      ).toContain(projectId);
      expect(await app.get(ServiceSkillReach).staleEnvironments()).toContain(projectId);
    });

    it('lays a new version when its Default environment’s SKILL.md changes outside a Publish', async () => {
      const service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      const appBuilder = await ensureBuiltInAgent('app-builder');
      await carryServiceSkill(appBuilder, service.id);
      const projectId = await createProject(app, admin.tenant, { agentId: appBuilder });
      const before = (await serviceSkillOf(service.id)).latestVersionId;
      const queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
      const since = queue.callsTo('add').length;

      await writeDevelopmentSkill(storageRoot, service.directory, `${PUBLISHED_SKILL}\nEdited in place.\n`);
      await app.get(ServiceRegistry).publishedCustom(service.id);

      await waitFor(async () => (await serviceSkillOf(service.id)).latestVersionId !== before);
      await waitFor(() =>
        queue
          .callsTo('add')
          .slice(since)
          .some(
            (call) => (call.args as { data: { projectEnvironmentId: string } }).data.projectEnvironmentId === projectId
          )
      );
    });

    it('lays the new version even when a Publish review reads the edited Default environment first', async () => {
      const service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      const before = (await serviceSkillOf(service.id)).latestVersionId;
      const registry = app.get(ServiceRegistry);

      await writeDevelopmentSkill(storageRoot, service.directory, `${PUBLISHED_SKILL}\nReviewed first.\n`);
      await registry.publishedAt(service.id, service.environmentId);
      await registry.publishedCustom(service.id);

      await waitFor(async () => (await serviceSkillOf(service.id)).latestVersionId !== before);
    });

    it('belongs to no person: its creator can leave, and a service with no creator still gets one', async () => {
      const publishWithCreator = async (slug: string, createdBy: string | null) => {
        const created = await createCustomService(app, admin, 'Lanes', slug);
        await db.update(externalServices).set({ createdBy }).where(eq(externalServices.id, created.id));
        const environment = await addServiceEnvironment(
          app,
          created.builderChatId,
          admin.tenant.tenantId,
          await productionEnvironmentOf(admin.tenant.tenantId)
        );
        await writeServiceFiles(storageRoot, environment.directory, BOARDS_MANIFEST);
        await app.get(ServiceDefaultEnvironments).publishedTo(created.builderChatId, environment.projectEnvironmentId);
        return created.id;
      };
      const leaving = await createUserRow();

      const owned = await publishWithCreator(`lanes-${crypto.randomUUID().slice(0, 6)}`, leaving);
      const orphan = await publishWithCreator(`lanes-${crypto.randomUUID().slice(0, 6)}`, null);

      expect((await serviceSkillOf(owned)).createdBy).toBeNull();
      await db.delete(users).where(eq(users.id, leaving));
      expect((await serviceSkillOf(orphan)).latestVersionId).not.toBeNull();
    });

    it('is dropped from every Agent when its builder chat is deleted as a plain Project', async () => {
      const service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      const appBuilder = await ensureBuiltInAgent('app-builder');
      await carryServiceSkill(appBuilder, service.id);
      const skillId = (await serviceSkillOf(service.id)).id;

      await app.get(ProjectService).remove(service.builderChatId, admin.tenant.tenantId);

      expect(await db.select().from(agentProfileSkills).where(eq(agentProfileSkills.skillId, skillId))).toEqual([]);
      expect(await db.select().from(skills).where(eq(skills.id, skillId))).toEqual([]);
    });

    it('takes the skill away on Disable, gives it back on Enable and takes it away on Delete', async () => {
      const service = await publishCustomService(app, admin, storageRoot, { slug: 'boards' });
      expect((await saveCustomServiceConfiguration(app, admin, service.id, READY_BOARDS)).statusCode).toBe(200);
      const appBuilder = await ensureBuiltInAgent('app-builder');
      await carryServiceSkill(appBuilder, service.id);
      const projectId = await createProject(app, admin.tenant, { agentId: appBuilder });
      expect(await app.get(DeliveryService).serviceSkillsFor(projectId)).toHaveLength(1);
      const queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
      const redelivered = (since: number) =>
        queue
          .callsTo('add')
          .slice(since)
          .map((call) => (call.args as { data: { projectEnvironmentId: string } }).data.projectEnvironmentId);
      const services = `/api/external-services/services/${service.id}`;

      let since = queue.callsTo('add').length;
      expect(
        (await app.inject({ method: 'POST', url: `${services}/disable`, headers: admin.headers })).statusCode
      ).toBe(200);
      expect(redelivered(since)).toContain(projectId);
      expect(await app.get(DeliveryService).serviceSkillsFor(projectId)).toEqual([]);

      since = queue.callsTo('add').length;
      expect((await app.inject({ method: 'POST', url: `${services}/enable`, headers: admin.headers })).statusCode).toBe(
        200
      );
      expect(redelivered(since)).toContain(projectId);
      expect(await app.get(DeliveryService).serviceSkillsFor(projectId)).toHaveLength(1);

      since = queue.callsTo('add').length;
      const deleted = await app.inject({
        method: 'DELETE',
        url: `${services}?confirmSlug=boards`,
        headers: admin.headers,
      });
      expect(deleted.statusCode, deleted.body).toBeLessThan(300);
      expect(redelivered(since)).toContain(projectId);
      expect(await app.get(DeliveryService).serviceSkillsFor(projectId)).toEqual([]);
    });
  });
});
