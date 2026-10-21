import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agentProfiles, agents, skills } from '../../db/schema';
import { AgentExportService } from '../../src/agent/agent-export.service';
import { AgentImportService } from '../../src/agent/agent-import.service';
import { AgentProfileService } from '../../src/agent/agent-profile.service';
import type { AgentCaller, AgentRow } from '../../src/agent/agent.types';
import { ProjectService } from '../../src/project/project.service';
import { TEST_PROJECT_KIND } from '../../src/project/project.types';
import { Perms } from '../../src/permission/permission.constants';
import { productionEnvironmentId } from '../../src/store/agent-profile.repository';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { addMember, createTenant, type MemberFixture, type TenantFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration, platformOperator } from './support/fixtures';
import {
  failHooks,
  forgetRecordedHooks,
  generatingBuiltInsDir,
  KEYS_SERVICE,
  READY_KEYS,
  recordedHook,
  saveServiceConfiguration,
} from './support/generating';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';
const SERVICE_SKILL = `service-${KEYS_SERVICE}`;

describe("a Custom Agent's service settings", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let tenant: TenantFixture;
  let manager: MemberFixture;
  let agent: AgentRow;
  let serviceSkillId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: generatingBuiltInsDir });
    app = harness.app;
    serviceId = await builtInServiceId(KEYS_SERVICE);
    await forgetPlatformServiceConfiguration(KEYS_SERVICE);
    await saveServiceConfiguration(app, await platformOperator(app), serviceId, READY_KEYS);
    const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.externalServiceId, serviceId));
    serviceSkillId = skill.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    forgetRecordedHooks();
    tenant = await createTenant(app);
    manager = await addMember(app, tenant, [Perms.manageAgents, Perms.configureProjectExternalServices]);
    const seeded = await seedLiveAgent(tenant.tenantId, manager.userId);
    agent = await agentRow(seeded.id);
    await profiles().setSkill(agent, managerCaller(), serviceSkillId, {});
  });

  function profiles(): AgentProfileService {
    return app.get(AgentProfileService);
  }

  function managerCaller(): AgentCaller {
    return { tenantId: tenant.tenantId, userId: manager.userId, canManageAgents: true };
  }

  async function agentRow(agentId: string): Promise<AgentRow> {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return { ...row, disabled: false };
  }

  async function createProjectOfAgent(): Promise<string> {
    const project = await app
      .get(ProjectService)
      .create({ agentId: agent.id }, tenant.tenantId, { createdBy: manager.userId });
    return project.id;
  }

  function readConfiguration(projectId: string) {
    return app.inject({
      method: 'GET',
      url: `/api/external-services/projects/${projectId}/environments/${projectId}/services/${serviceId}`,
      headers: manager.headers,
    });
  }

  it("gives a new Project of the Agent a saved configuration with the settings' values, announced and delivered", async () => {
    await setSettings({ greeting: 'hello' });

    const projectId = await createProjectOfAgent();

    const view = await readConfiguration(projectId);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().projectConfiguration).toMatchObject({ saved: true, values: { greeting: 'hello' } });
    expect(recordedHook(`hooks/project/${projectId}`)).toMatchObject({ previous: null, greeting: 'hello' });
    expect(
      existsSync(path.join(storageMountPath, 'projects', projectId, '.opencode/skills', SERVICE_SKILL, 'SKILL.md'))
    ).toBe(true);
  });

  function setSettings(values: Record<string, unknown>, canConfigureProjects = true, target: AgentRow = agent) {
    return profiles().setServiceSettings(target, managerCaller(), serviceSkillId, { values }, { canConfigureProjects });
  }

  async function storedSettingsOf(agentId: string, environmentId: string) {
    const [row] = await db
      .select({ serviceSettings: agentProfileSkills.serviceSettings })
      .from(agentProfileSkills)
      .innerJoin(agentProfiles, eq(agentProfiles.id, agentProfileSkills.profileId))
      .where(
        and(
          eq(agentProfiles.agentId, agentId),
          eq(agentProfiles.environmentId, environmentId),
          eq(agentProfileSkills.skillId, serviceSkillId)
        )
      );
    return row?.serviceSettings;
  }

  function storeSettingsDirectly(settings: Record<string, string>) {
    return db
      .update(agentProfileSkills)
      .set({ serviceSettings: settings })
      .where(eq(agentProfileSkills.skillId, serviceSkillId));
  }

  it("shows the saved settings on the Agent's Skills and drops them with the Service skill", async () => {
    await setSettings({ greeting: 'hello' });
    const listed = await profiles().listSkills(agent, managerCaller());
    expect(listed.find((skill) => skill.skillId === serviceSkillId)?.serviceSettings).toEqual({ greeting: 'hello' });
    const view = await profiles().serviceSettings(agent, managerCaller(), serviceSkillId);
    expect(view.service).toMatchObject({ id: serviceId, slug: KEYS_SERVICE });
    expect(view.service.manifest).toEqual({ projectForm: expect.any(Array) });

    await profiles().removeSkill(agent, managerCaller(), serviceSkillId);
    await profiles().setSkill(agent, managerCaller(), serviceSkillId, {});

    const again = await profiles().listSkills(agent, managerCaller());
    expect(again.find((skill) => skill.skillId === serviceSkillId)?.serviceSettings).toBeNull();
  });

  it('refuses service settings on a Built-in Agent', async () => {
    const builtIn = await agentRow(await ensureBuiltInAgent('app-builder'));
    await expect(setSettings({}, true, builtIn)).rejects.toMatchObject({
      response: { code: 'built_in_agent' },
    });
  });

  it('snapshots the settings at creation: later changes leave existing Projects alone', async () => {
    await setSettings({ greeting: 'hello' });
    const before = await createProjectOfAgent();

    await setSettings({ greeting: 'goodbye' });
    const after = await createProjectOfAgent();

    expect((await readConfiguration(before)).json().projectConfiguration.values.greeting).toBe('hello');
    expect((await readConfiguration(after)).json().projectConfiguration.values.greeting).toBe('goodbye');
  });

  it('ignores settings the service no longer declares', async () => {
    await storeSettingsDirectly({ greeting: 'hello', retiredSetting: 'on' });

    const projectId = await createProjectOfAgent();

    expect((await readConfiguration(projectId)).json().projectConfiguration.values).toMatchObject({
      greeting: 'hello',
    });
    expect((await readConfiguration(projectId)).json().projectConfiguration.values).not.toHaveProperty(
      'retiredSetting'
    );
  });

  it('leaves a new Project unconfigured when the Agent has no settings for the service', async () => {
    const projectId = await createProjectOfAgent();

    expect((await readConfiguration(projectId)).json().projectConfiguration.saved).toBe(false);
  });

  it('keeps the configuration with a "Saved, but" failure to Retry when the save hook fails, and creates the Project', async () => {
    failHooks({ project: true });
    await setSettings({ greeting: 'hello' });

    const projectId = await createProjectOfAgent();

    const view = (await readConfiguration(projectId)).json();
    expect(view.projectConfiguration.saved).toBe(true);
    expect(view.hookFailure).toMatchObject({ code: 'service-failed' });
  });

  it("configures the Agent's Test Project from its settings", async () => {
    await setSettings({ greeting: 'hello' });
    const project = await app
      .get(ProjectService)
      .create({ agentId: agent.id }, tenant.tenantId, { createdBy: manager.userId, kind: TEST_PROJECT_KIND });

    expect((await readConfiguration(project.id)).json().projectConfiguration).toMatchObject({
      saved: true,
      values: { greeting: 'hello' },
    });
  });

  it('configures a Duplicated or Imported Project of the Agent once its files are in place', async () => {
    const source = await createProjectOfAgent();
    await setSettings({ greeting: 'hello' });
    const copy = await app.get(ProjectService).duplicate(source, tenant.tenantId, undefined, manager.userId);

    await app.get(ProjectService).configureCopiedProject(copy.id);

    expect((await readConfiguration(copy.id)).json().projectConfiguration).toMatchObject({
      saved: true,
      values: { greeting: 'hello' },
    });
    expect(recordedHook(`hooks/project/${copy.id}`)).toMatchObject({ previous: null });
  });

  it("delivers a copied Project's Service skill before its save hook runs", async () => {
    const source = await createProjectOfAgent();
    await setSettings({ greeting: 'hello' });
    const copy = await app.get(ProjectService).duplicate(source, tenant.tenantId, undefined, manager.userId);

    await app.get(ProjectService).configureCopiedProject(copy.id);

    expect(recordedHook(`hooks/project/${copy.id}`)).toMatchObject({ skillDelivered: true });
  });

  it('copies the settings to Production with the Skill pins on Publish', async () => {
    const production = await productionEnvironmentId(tenant.tenantId);
    await setSettings({ greeting: 'hello' });
    await profiles().publish(agent, managerCaller(), { environmentId: production });

    await setSettings({ greeting: 'goodbye' });
    const published = await profiles().publish(agent, managerCaller(), { environmentId: production });

    expect(published.applied.serviceSettings).toEqual([SERVICE_SKILL]);
    expect(await storedSettingsOf(agent.id, production)).toEqual({ greeting: 'goodbye' });
  });

  describe('Agent Export and Import', () => {
    let scratchDir: string;

    beforeAll(async () => {
      scratchDir = await mkdtemp(path.join(tmpdir(), 'agent-service-settings-'));
    });

    afterAll(async () => {
      await rm(scratchDir, { recursive: true, force: true });
    });

    async function exportedArchive(): Promise<string> {
      const exported = await app.get(AgentExportService).export(managerCaller(), agent.id);
      const file = path.join(scratchDir, `${crypto.randomUUID()}.zip`);
      await writeFile(file, exported.archive);
      return file;
    }

    async function importer(): Promise<AgentCaller> {
      const target = await createTenant(app);
      const member = await addMember(app, target, [Perms.manageAgents, Perms.manageSkills]);
      return { tenantId: target.tenantId, userId: member.userId, canManageAgents: true };
    }

    function importAs(caller: AgentCaller, archive: string, canConfigureProjects = true) {
      return app
        .get(AgentImportService)
        .import(caller, archive, { displayName: null, projectSettings: {} }, { canConfigureProjects });
    }

    it("drops a service that isn't Available in the importing Organization, saying so", async () => {
      await setSettings({ greeting: 'hello' });
      const archive = await exportedArchive();
      const caller = await importer();
      await forgetPlatformServiceConfiguration(KEYS_SERVICE);
      try {
        const imported = await importAs(caller, archive);

        expect(imported.notes).toContainEqual(
          expect.objectContaining({ name: SERVICE_SKILL, message: expect.stringContaining('service settings') })
        );
      } finally {
        await saveServiceConfiguration(app, await platformOperator(app), serviceId, READY_KEYS);
      }
    });
  });

  it('exposes no service settings through the Public API', async () => {
    await setSettings({ greeting: 'hello' });
    const caller = await addMember(app, tenant, [Perms.usePublicApi, Perms.manageAgents]);

    const document = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const skillsRead = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${agent.id}/skills`,
      headers: caller.headers,
    });

    expect(document.statusCode).toBe(200);
    expect(document.body).not.toMatch(/service-settings|serviceSettings/);
    expect(skillsRead.statusCode, skillsRead.body).toBe(200);
    expect(skillsRead.body).not.toContain('serviceSettings');
  });
});
