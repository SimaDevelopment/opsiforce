import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfiles, agents, agentProfileSkills, projectSkillDeliveries, skills } from '../../db/schema';
import { AgentProfileService } from '../../src/agent/agent-profile.service';
import { DEFAULT_AGENT_NAME, type AgentRow } from '../../src/agent/agent.types';
import { SKILL_DELIVERY_QUEUE } from '../../src/delivery/delivery.types';
import { SkillDeliveryService } from '../../src/delivery/skill-delivery.service';
import { EnvironmentService } from '../../src/environment/environment.service';
import { ServiceConsumers } from '../../src/external-services/configuration/service-consumers';
import { ServiceSkillReach } from '../../src/external-services/knowledge/service-skill-reach';
import { ProjectService } from '../../src/project/project.service';
import { productionEnvironmentId } from '../../src/store/agent-profile.repository';
import { SkillRepository } from '../../src/store/skill.repository';
import { SkillService, type SkillCaller } from '../../src/store/skill.service';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { fixtureCrmEvolved, type EvolvedBuiltIns } from './support/evolved-built-ins';
import { ensureExternalServiceBuilder } from './support/custom-services';
import {
  builtInServiceId,
  forgetPlatformServiceConfiguration,
  platformOperator,
  tenantAdmin,
} from './support/fixtures';
import { configurePlatformService, READY_FIXTURE_CRM, storeProjectConfiguration } from './support/gate';
import { publishCustomService } from './support/published-services';
import { SDK2_BOARDS_MANIFEST } from './support/sdk2-service-pod';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import type { FakeQueue } from '../support/infra-fakes';
import { createTenantRow, createUserRow } from '../support/org-fixtures';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const SERVICE_SKILL = `service-${FIXTURE_SERVICE}`;

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
let queue: FakeQueue;
let deliveries: SkillDeliveryService;
let tenantId: string;
let userId: string;
let fixtureId: string;

beforeAll(async () => {
  harness = await createExternalServicesTestApp();
  app = harness.app;
  queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
  deliveries = app.get(SkillDeliveryService);
  fixtureId = await builtInServiceId(FIXTURE_SERVICE);
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  tenantId = await createTenantRow();
  userId = await createUserRow();
  await app.get(EnvironmentService).ensureDefaultForTenant(tenantId);
  await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
  await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM);
});

async function serviceSkillRow() {
  const [row] = await db.select().from(skills).where(eq(skills.externalServiceId, fixtureId));
  if (!row) throw new Error(`${FIXTURE_SERVICE} has no Service skill`);
  return row;
}

async function agentRow(agentId: string): Promise<AgentRow> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  return { ...agent, disabled: false };
}

function agentCaller() {
  return { tenantId, userId, canManageAgents: true };
}

function skillCaller(): SkillCaller {
  return { tenantId, userId, canManageSkills: true };
}

async function addServiceSkill(agentId: string): Promise<void> {
  const skill = await serviceSkillRow();
  await app.get(AgentProfileService).setSkill(await agentRow(agentId), agentCaller(), skill.id, {});
}

async function removeServiceSkill(agentId: string): Promise<void> {
  const skill = await serviceSkillRow();
  await app.get(AgentProfileService).removeSkill(await agentRow(agentId), agentCaller(), skill.id);
}

async function customAgent(): Promise<string> {
  return (await seedLiveAgent(tenantId, userId)).id;
}

async function createProject(agentId: string): Promise<string> {
  const project = await app.get(ProjectService).create({ agentId }, tenantId, { createdBy: userId });
  return project.id;
}

function workspace(projectEnvironmentId: string, ...segments: string[]): string {
  return path.join(storageMountPath, 'projects', projectEnvironmentId, ...segments);
}

async function installedSkillNames(projectEnvironmentId: string): Promise<string[]> {
  const entries = await readdir(workspace(projectEnvironmentId, '.opencode/skills'), { withFileTypes: true }).catch(
    () => []
  );
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function recordedServiceSkill(projectEnvironmentId: string) {
  const [row] = await db
    .select()
    .from(projectSkillDeliveries)
    .where(
      and(
        eq(projectSkillDeliveries.projectEnvironmentId, projectEnvironmentId),
        eq(projectSkillDeliveries.skillName, SERVICE_SKILL)
      )
    );
  return row;
}

function serviceSkillFile(projectEnvironmentId: string): Promise<string> {
  return readFile(workspace(projectEnvironmentId, '.opencode/skills', SERVICE_SKILL, 'SKILL.md'), 'utf8');
}

function enqueuedSince(before: number): string[] {
  return queue
    .callsTo('add')
    .slice(before)
    .map((call) => (call.args.data as { projectEnvironmentId: string }).projectEnvironmentId);
}

describe('the Service skill in the Store', () => {
  it('is a built-in Skill in the Store marked by its service, laid at boot from the folder’s SKILL.md', async () => {
    const skill = await serviceSkillRow();

    expect(skill).toMatchObject({ name: SERVICE_SKILL, origin: 'built_in', tenantId: null });
    if (!skill.latestVersionId) throw new Error('No version laid');
    const [file] = await app.get(SkillRepository).readTree(skill.latestVersionId);
    expect(file?.content.toString()).toMatch(/^---\nname: service-fixture-crm\n/);
    expect(file?.content.toString()).toContain('Accounts belong to pipelines.');
    expect(file?.content.toString()).toContain('https://fixture-crm.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce');
  });

  it('lays no new version when the service’s document has not changed', async () => {
    const before = (await serviceSkillRow()).latestVersionId;

    await app.get(ServiceSkillReach).onApplicationBootstrap();

    expect((await serviceSkillRow()).latestVersionId).toBe(before);
  });

  it('refuses every edit, whoever asks', async () => {
    const skill = await serviceSkillRow();
    const store = app.get(SkillService);
    const refused = expect.objectContaining({
      response: expect.objectContaining({ code: 'service_skill_read_only' }),
    });

    await expect(
      store.addVersion(skillCaller(), skill.id, {
        files: [{ path: 'SKILL.md', content: `---\nname: ${SERVICE_SKILL}\ndescription: x\n---\nx\n` }],
      })
    ).rejects.toEqual(refused);
    await expect(store.update(skillCaller(), skill.id, { displayName: 'Mine' })).rejects.toEqual(refused);
    await expect(store.setDisabled(skillCaller(), skill.id, true)).rejects.toEqual(refused);
    await expect(store.remove(skillCaller(), skill.id, () => Promise.resolve())).rejects.toEqual(refused);
    expect((await store.findOne(skillCaller(), skill.id)).externalServiceId).toBe(fixtureId);
  });
});

describe('an Agent that carries the Service skill', () => {
  it('delivers it to a new Project of the Agent at the latest version', async () => {
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    await addServiceSkill(agentId);

    const projectId = await createProject(agentId);

    expect(await serviceSkillFile(projectId)).toContain('Accounts belong to pipelines.');
    expect((await recordedServiceSkill(projectId))?.skillVersionId).toBe((await serviceSkillRow()).latestVersionId);
  });

  it('reaches a running Project of a Custom Agent live, and takes it away when removed', async () => {
    const agentId = await customAgent();
    const projectId = await createProject(agentId);
    const added = queue.callsTo('add').length;

    await addServiceSkill(agentId);

    expect(enqueuedSince(added)).toContain(projectId);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).toContain(SERVICE_SKILL);

    const removed = queue.callsTo('add').length;
    await removeServiceSkill(agentId);

    expect(enqueuedSince(removed)).toContain(projectId);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
    expect(await recordedServiceSkill(projectId)).toBeUndefined();
  });

  it('refuses to add the Service skill while its service is not Available', async () => {
    const agentId = await customAgent();
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);

    const refused = addServiceSkill(agentId);

    await expect(refused).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'service_unavailable' }),
    });
  });

  it('pins the latest version whatever version the editor asks for', async () => {
    const agentId = await customAgent();
    const skill = await serviceSkillRow();

    const carried = await app
      .get(AgentProfileService)
      .setSkill(await agentRow(agentId), agentCaller(), skill.id, { versionId: 'not-a-version' });

    expect(carried.find((entry) => entry.skillId === skill.id)).toMatchObject({
      pinnedVersionId: skill.latestVersionId,
      externalServiceId: fixtureId,
      updateAvailable: false,
    });
  });

  it('gets nothing while the service is not Available, and is reached when it becomes Available', async () => {
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    await addServiceSkill(agentId);
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);

    const projectId = await createProject(agentId);
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
    const before = queue.callsTo('add').length;

    const operator = await platformOperator(app);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/external-services/platform/services/${fixtureId}/configuration`,
      headers: operator.headers,
      payload: { values: READY_FIXTURE_CRM },
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(enqueuedSince(before)).toContain(projectId);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).toContain(SERVICE_SKILL);
  });

  it('loses it when the service is no longer Available, found by the boot pass', async () => {
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    await addServiceSkill(agentId);
    const projectId = await createProject(agentId);
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    const before = queue.callsTo('add').length;

    await app.get(ServiceSkillReach).onApplicationBootstrap();

    expect(enqueuedSince(before)).toContain(projectId);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
  });

  it('is carried to the Production profile by a Publish of the Custom Agent', async () => {
    const agentId = await customAgent();
    await addServiceSkill(agentId);
    const productionId = await productionEnvironmentId(tenantId);

    await app.get(AgentProfileService).publish(await agentRow(agentId), agentCaller(), { environmentId: productionId });

    const [production] = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, productionId)));
    const carried = await db
      .select({ skillId: agentProfileSkills.skillId })
      .from(agentProfileSkills)
      .where(eq(agentProfileSkills.profileId, production.id));
    expect(carried).toContainEqual({ skillId: (await serviceSkillRow()).id });
  });

  it('leaves a Custom Agent’s other Skills alone when a delivery reaches it', async () => {
    const projectId = await createProject(await customAgent());

    expect(await deliveries.reconcile(projectId)).toEqual({
      status: 'converged',
      written: [],
      deleted: [],
      omitted: [],
    });
  });
});

describe('a Project that configures a service its Agent does not carry', () => {
  it('gets the Service skill in that environment only', async () => {
    const agentId = await customAgent();
    const configured = await createProject(agentId);
    const other = await createProject(agentId);

    await storeProjectConfiguration(FIXTURE_SERVICE, configured, { _labels: {} });
    await deliveries.deliver({ projectEnvironmentId: configured, attempt: 0 });
    await deliveries.deliver({ projectEnvironmentId: other, attempt: 0 });

    expect(await installedSkillNames(configured)).toContain(SERVICE_SKILL);
    expect(await installedSkillNames(other)).not.toContain(SERVICE_SKILL);
  });

  it('loses it when the Project disconnects the service', async () => {
    const projectId = await createProject(await customAgent());
    await storeProjectConfiguration(FIXTURE_SERVICE, projectId, { _labels: {} });
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).toContain(SERVICE_SKILL);
    const before = queue.callsTo('add').length;

    await app.get(ServiceConsumers).disconnect(fixtureId, projectId);

    expect(enqueuedSince(before)).toContain(projectId);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
  });
});

describe('a service folder without SKILL.md', () => {
  let evolved: EvolvedBuiltIns;
  let bare: ExternalServicesTestApp;

  beforeAll(async () => {
    evolved = await fixtureCrmEvolved(() => undefined);
    bare = await createExternalServicesTestApp({ builtInsDir: evolved.dir });
  });

  afterAll(async () => {
    await bare.close();
    await evolved.remove();
  });

  it('teaches the service with a minimal Service skill from its displayName and description', async () => {
    const agentId = await customAgent();
    const skill = await serviceSkillRow();
    await bare.app.get(AgentProfileService).setSkill(await agentRow(agentId), agentCaller(), skill.id, {});

    const project = await bare.app.get(ProjectService).create({ agentId }, tenantId, { createdBy: userId });

    const file = await serviceSkillFile(project.id);
    expect(file).toMatch(/^---\nname: service-fixture-crm\ndescription: Fixture CRM — A pretend CRM/);
    expect(file).toContain('# Fixture CRM');
    expect(file).toContain('https://fixture-crm.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce');
  });
});

describe('the Service skill of an SDK 2 service', () => {
  let sdk2: ExternalServicesTestApp;
  let storageRoot: string;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(path.join(tmpdir(), 'sdk2-service-skill-'));
    sdk2 = await createExternalServicesTestApp({ env: { STORAGE_MOUNT_PATH: storageRoot } });
  });

  afterAll(async () => {
    await sdk2.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('points at the Service host and its /.well-known/opsiforce, and at no Operation endpoint', async () => {
    const admin = await tenantAdmin(sdk2.app);
    const slug = `boards-${crypto.randomUUID().slice(0, 8)}`;
    const service = await publishCustomService(sdk2.app, admin, storageRoot, { slug, manifest: SDK2_BOARDS_MANIFEST });

    const [skill] = await db.select().from(skills).where(eq(skills.externalServiceId, service.id));
    if (!skill?.latestVersionId) throw new Error(`${slug} has no Service skill`);
    const [file] = await sdk2.app.get(SkillRepository).readTree(skill.latestVersionId);
    const content = file?.content.toString() ?? '';

    expect(content).toMatch(new RegExp(`^---\\nname: service-${slug}\\n`));
    expect(content).toContain(`https://${slug}.$EXTERNAL_SERVICES_HOST`);
    expect(content).toContain(`https://${slug}.$EXTERNAL_SERVICES_HOST/.well-known/opsiforce`);
    for (const retired of ['EXTERNAL_SERVICES_URL', 'openapi.json', '/calls', '<operation>']) {
      expect(content, retired).not.toContain(retired);
    }
  });
});
