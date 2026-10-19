import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, environments, projectSkillDeliveries, skills as storeSkills } from '../../db/schema';
import { AgentService } from '../../src/agent/agent.service';
import { DEFAULT_AGENT_NAME, type AgentCaller } from '../../src/agent/agent.types';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { SKILL_DELIVERY_QUEUE } from '../../src/delivery/delivery.types';
import { EnvironmentSkillsService } from '../../src/delivery/environment-skills';
import { SkillDeliveryService } from '../../src/delivery/skill-delivery.service';
import { EnvironmentService } from '../../src/environment/environment.service';
import { Perms } from '../../src/permission/permission.constants';
import { PodService } from '../../src/pod/pod.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectSkillsModule } from '../../src/project-skills/project-skills.module';
import { ProjectStatus } from '../../src/project/project.types';
import { builtInProfileFor } from '../../src/store/agent-profile.repository';
import { SkillService, type SkillCaller } from '../../src/store/skill.service';
import { createExternalServicesTestApp, FIXTURE_SERVICE, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from './support/fixtures';
import { configurePlatformService, READY_FIXTURE_CRM, storeProjectConfiguration } from './support/gate';
import { manifest, validDescription } from '../store/support/skill-fixtures';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { startFakePod, type FakePod } from '../support/fake-pod';
import type { FakePodService, FakeQueue } from '../support/infra-fakes';
import {
  addMember,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const CONTROL_TOKEN = 'switch-off-control-token';
const SERVICE_SKILL = `service-${FIXTURE_SERVICE}`;
const AGENT_CONFIG = path.resolve('../agent-config');

let pod: FakePod;
let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
let queue: FakeQueue;
let deliveries: SkillDeliveryService;
let tenant: TenantFixture;
let agentId: string;
let editor: AgentCaller;
let skillAuthor: SkillCaller;
let skillManager: MemberFixture;

beforeAll(async () => {
  pod = await startFakePod();
  harness = await createExternalServicesTestApp({
    env: {
      AGENT_PORT: String(pod.port),
      AGENT_CONTROL_PORT: String(pod.port),
      SKILL_DELIVERY_CONFIRM_ATTEMPTS: '2',
      SKILL_DELIVERY_CONFIRM_POLL_MS: '10',
    },
    extraModules: [ProjectSkillsModule],
  });
  app = harness.app;
  queue = app.get<FakeQueue>(getQueueToken(SKILL_DELIVERY_QUEUE));
  deliveries = app.get(SkillDeliveryService);
  agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
});

afterAll(async () => {
  await harness.close();
  await pod.stop();
});

beforeEach(async () => {
  tenant = await createTenant(app);
  await app.get(EnvironmentService).ensureDefaultForTenant(tenant.tenantId);
  skillManager = await addMember(app, tenant, [Perms.manageProjectSkills]);
  editor = { tenantId: tenant.tenantId, userId: skillManager.userId, canManageAgents: true };
  skillAuthor = { tenantId: tenant.tenantId, userId: skillManager.userId, canManageSkills: true };
});

async function storeSkill(prefix: string, body = '# v1\n'): Promise<{ id: string; name: string }> {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const skills = app.get(SkillService);
  const summary = await skills.create(skillAuthor, {
    name,
    files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, body) }],
  });
  await skills.setVisibility(skillAuthor, summary.id, { visibility: 'public' });
  return { id: summary.id, name };
}

async function republish(skill: { id: string; name: string }, body: string): Promise<void> {
  await app.get(SkillService).addVersion(skillAuthor, skill.id, {
    files: [{ path: 'SKILL.md', content: manifest(`name: ${skill.name}\ndescription: ${validDescription}`, body) }],
  });
}

async function runningProject(ofAgentId = agentId): Promise<string> {
  const projectId = await createProject(app, tenant, { agentId: ofAgentId });
  const pods = app.get<FakePodService>(PodService);
  await app.get(ProjectEnvironmentService).patch(projectId, { status: ProjectStatus.Active, podIp: '127.0.0.1' });
  pods.setPod(pods.assignedPodName(projectId), '127.0.0.1', CONTROL_TOKEN);
  pod.serveSkills(() => installedSkillNames(projectId));
  return projectId;
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

async function recordedSkillNames(projectEnvironmentId: string): Promise<string[]> {
  const rows = await db
    .select({ name: projectSkillDeliveries.skillName })
    .from(projectSkillDeliveries)
    .where(eq(projectSkillDeliveries.projectEnvironmentId, projectEnvironmentId));
  return rows.map((row) => row.name);
}

function skillsUrl(projectId: string, projectEnvironmentId = projectId): string {
  return `/api/projects/${projectId}/environments/${projectEnvironmentId}/skills`;
}

function switchSkill(
  person: MemberFixture,
  projectId: string,
  name: string,
  on: boolean,
  projectEnvironmentId = projectId
) {
  return app.inject({
    method: 'PUT',
    url: `${skillsUrl(projectId, projectEnvironmentId)}/${name}`,
    headers: person.headers,
    payload: { on },
  });
}

async function listedSkills(person: MemberFixture, projectId: string, projectEnvironmentId = projectId) {
  const res = await app.inject({
    method: 'GET',
    url: skillsUrl(projectId, projectEnvironmentId),
    headers: person.headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    skills: Array<{
      name: string;
      kind: string;
      state: string;
      service: string | null;
      carried: boolean;
    }>;
  };
}

function enqueuedFor(projectEnvironmentId: string): number {
  return queue
    .callsTo('add')
    .filter(
      (call) => (call.args.data as { projectEnvironmentId?: string }).projectEnvironmentId === projectEnvironmentId
    ).length;
}

describe('switching a Store Skill off in one environment', () => {
  it('removes brand-globex from the environment, and the fan-out never lays it again', async () => {
    const brand = await storeSkill('brand-globex');
    await app.get(AgentService).setSkill(editor, agentId, brand.id, {});
    const projectId = await runningProject();
    expect(await installedSkillNames(projectId)).toContain(brand.name);
    const enqueuedBefore = enqueuedFor(projectId);
    const notifiedBefore = pod.requestsTo('notify.configChange').length;

    const res = await switchSkill(skillManager, projectId, brand.name, false);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skills.find((skill: { name: string }) => skill.name === brand.name)).toMatchObject({
      kind: 'store',
      state: 'switched-off',
    });
    expect(enqueuedFor(projectId)).toBeGreaterThan(enqueuedBefore);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(brand.name);
    expect(await recordedSkillNames(projectId)).not.toContain(brand.name);
    expect(pod.requestsTo('notify.configChange').length).toBeGreaterThan(notifiedBefore);

    await republish(brand, '# v2\n');
    await app.get(AgentService).setSkill(editor, agentId, brand.id, {});
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(brand.name);
  });
});

describe('switching a Skill back on', () => {
  it('lays the Version the Agent carries now', async () => {
    const brand = await storeSkill('brand-acme');
    await app.get(AgentService).setSkill(editor, agentId, brand.id, {});
    const projectId = await runningProject();
    await switchSkill(skillManager, projectId, brand.name, false);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    await republish(brand, '# v2\n');
    await app.get(AgentService).setSkill(editor, agentId, brand.id, {});

    const res = await switchSkill(skillManager, projectId, brand.name, true);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skills.find((skill: { name: string }) => skill.name === brand.name)).toMatchObject({
      state: 'switching-on',
    });
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await skillFile(projectId, brand.name)).toContain('# v2');
    expect(await listedSkill(skillManager, projectId, brand.name)).toMatchObject({ state: 'on' });
  });

  it('moves a Custom Agent Project’s Skill forward to the Agent’s current Version, and nothing else', async () => {
    const custom = await seedLiveAgent(tenant.tenantId, skillManager.userId);
    const brand = await storeSkill('brand-initech');
    const other = await storeSkill('tone-initech');
    await app.get(AgentService).setSkill(editor, custom.id, brand.id, {});
    await app.get(AgentService).setSkill(editor, custom.id, other.id, {});
    const projectId = await runningProject(custom.id);
    await republish(brand, '# brand v2\n');
    await republish(other, '# tone v2\n');
    await app.get(AgentService).setSkill(editor, custom.id, brand.id, {});
    await app.get(AgentService).setSkill(editor, custom.id, other.id, {});

    await switchSkill(skillManager, projectId, brand.name, false);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(brand.name);
    const res = await switchSkill(skillManager, projectId, brand.name, true);

    expect(res.statusCode, res.body).toBe(200);
    expect(await skillFile(projectId, brand.name)).toContain('# brand v2');
    expect(await skillFile(projectId, other.name)).toContain('# v1');
    expect(await recordedSkillNames(projectId)).toContain(brand.name);
  });

  it('lays a package Skill from the Agent’s package', async () => {
    const projectId = await runningProject();
    await stagePackageSkill(projectId, 'web-app');

    await switchSkill(skillManager, projectId, 'web-app', false);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain('web-app');
    const res = await switchSkill(skillManager, projectId, 'web-app', true);

    expect(res.statusCode, res.body).toBe(200);
    expect(await skillFile(projectId, 'web-app')).toBe(
      await readFile(path.join(AGENT_CONFIG, 'skills/web-app/SKILL.md'), 'utf8')
    );
    expect(await recordedSkillNames(projectId)).not.toContain('web-app');
  });
});

describe('a package Skill', () => {
  it('is listed with no reason to keep it, and is removed when switched off', async () => {
    const projectId = await runningProject();
    await stagePackageSkill(projectId, 'web-app');

    const listed = await listedSkill(skillManager, projectId, 'web-app');
    expect(listed).toMatchObject({ kind: 'package', state: 'on', carried: true });
    expect(Object.keys(listed ?? {}).toSorted()).toEqual([
      'carried',
      'description',
      'kind',
      'name',
      'service',
      'state',
    ]);

    await switchSkill(skillManager, projectId, 'web-app', false);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });

    expect(await installedSkillNames(projectId)).not.toContain('web-app');
  });
});

describe('a Service skill', () => {
  beforeEach(async () => {
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM);
  });

  async function carryServiceSkill(): Promise<void> {
    const profile = await builtInProfileFor(agentId, tenant.tenantId);
    const [skill] = await db
      .select({ id: storeSkills.id, latestVersionId: storeSkills.latestVersionId })
      .from(storeSkills)
      .where(eq(storeSkills.externalServiceId, await builtInServiceId(FIXTURE_SERVICE)));
    if (!skill?.latestVersionId) throw new Error(`${SERVICE_SKILL} has no version`);
    await db
      .insert(agentProfileSkills)
      .values({ profileId: profile.id, skillId: skill.id, skillVersionId: skill.latestVersionId })
      .onConflictDoNothing();
  }

  it('is switched off by a configurer, and neither the fan-out nor a fresh delivery lays it again', async () => {
    await carryServiceSkill();
    const projectId = await runningProject();
    expect(await installedSkillNames(projectId)).toContain(SERVICE_SKILL);
    const configurer = await addMember(app, tenant, [Perms.configureProjectExternalServices]);

    const res = await switchSkill(configurer, projectId, SERVICE_SKILL, false);

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skills.find((skill: { name: string }) => skill.name === SERVICE_SKILL)).toMatchObject({
      kind: 'service',
      service: FIXTURE_SERVICE,
      state: 'switched-off',
    });
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
    await app.get(DeliveryService).redeliverIntoWipedWorkspace(projectId);
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
  });

  it('stays off in a Project that configures the service while its Agent does not carry it', async () => {
    const projectId = await runningProject();
    const configurer = await addMember(app, tenant, [Perms.configureProjectExternalServices]);
    await storeProjectConfiguration(FIXTURE_SERVICE, projectId, { _labels: {} });
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).toContain(SERVICE_SKILL);

    const res = await switchSkill(configurer, projectId, SERVICE_SKILL, false);

    expect(res.statusCode, res.body).toBe(200);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    expect(await installedSkillNames(projectId)).not.toContain(SERVICE_SKILL);
  });

  it('needs the configurer’s permission, not the Skills one', async () => {
    await carryServiceSkill();
    const projectId = await runningProject();

    const res = await switchSkill(skillManager, projectId, SERVICE_SKILL, false);

    expect(res.statusCode, res.body).toBe(403);
  });
});

describe('who may switch what', () => {
  it('refuses a Store Skill to someone without can_manage_project_skills, but shows them the list', async () => {
    const brand = await storeSkill('brand-hooli');
    await app.get(AgentService).setSkill(editor, agentId, brand.id, {});
    const projectId = await runningProject();
    const member = await addMember(app, tenant, [Perms.configureProjectExternalServices]);

    const res = await switchSkill(member, projectId, brand.name, false);

    expect(res.statusCode, res.body).toBe(403);
    expect(await listedSkill(member, projectId, brand.name)).toMatchObject({ state: 'on' });
  });

  it('keeps platform always on', async () => {
    const projectId = await runningProject();

    const res = await switchSkill(skillManager, projectId, 'platform', false);

    expect(res.statusCode, res.body).toBe(409);
    expect(await listedSkill(skillManager, projectId, 'platform')).toMatchObject({
      kind: 'platform',
      state: 'always-on',
    });
  });

  it('answers 404 for a Skill the environment does not have', async () => {
    const projectId = await runningProject();

    const res = await switchSkill(skillManager, projectId, 'no-such-skill', false);

    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('the popover’s states', () => {
  it('shows a Skill that could not be delivered as retrying', async () => {
    const brand = await storeSkill('brand-umbrella');
    await app.get(AgentService).setSkill(editor, agentId, brand.id, {});
    const projectId = await runningProject();
    await switchSkill(skillManager, projectId, brand.name, false);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });
    pod.serveSkills(() => []);

    await switchSkill(skillManager, projectId, brand.name, true);
    const failure = await deliveries
      .deliver({ projectEnvironmentId: projectId, attempt: 0 })
      .catch((err: Error) => err);
    await deliveries.recordFailure({ projectEnvironmentId: projectId, attempt: 0 }, failure as Error);

    expect(await listedSkill(skillManager, projectId, brand.name)).toMatchObject({ state: 'retrying' });
  });

  it('keeps a Custom Agent’s dropped Skill while present, marked final, and drops it once switched off', async () => {
    const custom = await seedLiveAgent(tenant.tenantId, skillManager.userId);
    const brand = await storeSkill('brand-soylent');
    await app.get(AgentService).setSkill(editor, custom.id, brand.id, {});
    const projectId = await runningProject(custom.id);
    await app.get(AgentService).removeSkill(editor, custom.id, brand.id);

    expect(await listedSkill(skillManager, projectId, brand.name)).toMatchObject({ state: 'on', carried: false });
    await switchSkill(skillManager, projectId, brand.name, false);
    await deliveries.deliver({ projectEnvironmentId: projectId, attempt: 0 });

    expect(await installedSkillNames(projectId)).not.toContain(brand.name);
    expect(await listedSkill(skillManager, projectId, brand.name)).toBeUndefined();
    expect((await switchSkill(skillManager, projectId, brand.name, true)).statusCode).toBe(409);
  });
});

describe('Publish (App)', () => {
  it('replaces the published environment’s switched-off set with Development’s', async () => {
    const globex = await storeSkill('brand-globex');
    const acme = await storeSkill('brand-acme');
    await app.get(AgentService).setSkill(editor, agentId, globex.id, {});
    await app.get(AgentService).setSkill(editor, agentId, acme.id, {});
    const projectId = await runningProject();
    const publishedId = await publishedEnvironment(projectId);
    await app.get(DeliveryService).copyToNewEnvironment(projectId, publishedId);
    await switchSkill(skillManager, projectId, globex.name, false);
    await switchSkill(skillManager, projectId, acme.name, false, publishedId);
    await switchSkill(skillManager, projectId, acme.name, true);
    const enqueuedBefore = enqueuedFor(publishedId);

    const report = await app.get(EnvironmentSkillsService).carry(projectId, publishedId);

    expect(report).toEqual([{ kind: 'skills-off', switchedOff: [globex.name], switchedOn: [acme.name] }]);
    expect(enqueuedFor(publishedId)).toBeGreaterThan(enqueuedBefore);
    expect(await listedSkill(skillManager, projectId, globex.name, publishedId)).toMatchObject({
      state: 'switched-off',
    });
    expect(await listedSkill(skillManager, projectId, acme.name, publishedId)).not.toMatchObject({
      state: 'switched-off',
    });
    await deliveries.deliver({ projectEnvironmentId: publishedId, attempt: 0 });
    expect(await installedSkillNames(publishedId)).not.toContain(globex.name);
    expect(await installedSkillNames(publishedId)).toContain(acme.name);
  });

  it('reports nothing when the sets already match', async () => {
    const projectId = await runningProject();
    const publishedId = await publishedEnvironment(projectId);

    expect(await app.get(EnvironmentSkillsService).carry(projectId, publishedId)).toEqual([]);
  });
});

async function publishedEnvironment(projectId: string): Promise<string> {
  const id = randomUUID();
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenant.tenantId), eq(environments.isDefault, false)))
    .limit(1);
  await app.get(ProjectEnvironmentService).create({
    id,
    projectId,
    environmentId: production.id,
    isDefault: false,
    directory: `projects/${id}`,
    platformVersion: '0.0.0-test',
    status: ProjectStatus.Suspended,
  });
  return id;
}

async function listedSkill(person: MemberFixture, projectId: string, name: string, projectEnvironmentId = projectId) {
  return (await listedSkills(person, projectId, projectEnvironmentId)).skills.find((skill) => skill.name === name);
}

async function skillFile(projectEnvironmentId: string, name: string): Promise<string> {
  return readFile(workspace(projectEnvironmentId, '.opencode/skills', name, 'SKILL.md'), 'utf8');
}

async function stagePackageSkill(projectEnvironmentId: string, name: string): Promise<void> {
  await mkdir(workspace(projectEnvironmentId, '.opencode/skills', name), { recursive: true });
  await writeFile(workspace(projectEnvironmentId, '.opencode/skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  await mkdir(workspace(projectEnvironmentId, '.opsiforce/agents'), { recursive: true });
  await writeFile(
    workspace(projectEnvironmentId, `.opsiforce/agents/${DEFAULT_AGENT_NAME}.json`),
    JSON.stringify({ package: DEFAULT_AGENT_NAME, contentVersion: '0.0.0', ownedSkills: [name] })
  );
}
