import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ServiceError } from '@opsiforce/external-service-sdk';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agentProfiles, agents, externalServiceCalls, skills } from '../../db/schema';
import { AgentExportService } from '../../src/agent/agent-export.service';
import { AgentImportService } from '../../src/agent/agent-import.service';
import { AgentProfileService } from '../../src/agent/agent-profile.service';
import { AgentService } from '../../src/agent/agent.service';
import type { AgentCaller, AgentDetail, AgentRow } from '../../src/agent/agent.types';
import { ProjectService } from '../../src/project/project.service';
import { TEST_PROJECT_KIND } from '../../src/project/project.types';
import { Perms } from '../../src/permission/permission.constants';
import { productionEnvironmentId } from '../../src/store/agent-profile.repository';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { addMember, createTenant, type MemberFixture, type TenantFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { builtInServiceId, forgetPlatformServiceConfiguration, platformOperator } from './support/fixtures';
import { dispatchToFakePod, type ServicePodFixture } from './support/gate';
import {
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

  it("gives a new Project of the Agent a saved configuration with the settings' switches, announced and delivered", async () => {
    await profiles().setServiceSettings(
      agent,
      managerCaller(),
      serviceSkillId,
      { operations: ['send_message'], receive: ['message.received'] },
      { canConfigureProjects: true }
    );

    const projectId = await createProjectOfAgent();

    const view = await readConfiguration(projectId);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().projectConfiguration).toMatchObject({
      saved: true,
      operations: { send_message: true },
      receive: { 'message.received': true },
    });
    expect(recordedHook(`hooks/project/${projectId}`)).toMatchObject({
      previous: null,
      receive: { 'message.received': true },
    });
    const [hookCall] = await db
      .select()
      .from(externalServiceCalls)
      .where(
        and(
          eq(externalServiceCalls.projectEnvironmentId, projectId),
          eq(externalServiceCalls.operation, 'onProjectConfigurationSaved')
        )
      );
    expect(hookCall).toMatchObject({ kind: 'hook', userId: manager.userId });
    expect(
      existsSync(path.join(storageMountPath, 'projects', projectId, '.opencode/skills', SERVICE_SKILL, 'SKILL.md'))
    ).toBe(true);
  });

  function setSettings(
    settings: { operations?: unknown; receive?: unknown },
    canConfigureProjects = true,
    target: AgentRow = agent
  ) {
    return profiles().setServiceSettings(target, managerCaller(), serviceSkillId, settings, { canConfigureProjects });
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

  function storeSettingsDirectly(settings: { operations: string[]; receive: string[] }) {
    return db
      .update(agentProfileSkills)
      .set({ serviceSettings: settings })
      .where(eq(agentProfileSkills.skillId, serviceSkillId));
  }

  it('refuses to turn a write Operation on without the project-configuration permission, naming it', async () => {
    await expect(setSettings({ operations: ['send_message'] }, false)).rejects.toMatchObject({
      response: {
        code: 'missing_permission',
        message: expect.stringContaining(Perms.configureProjectExternalServices),
      },
    });
    await expect(setSettings({ receive: ['message.received'] }, false)).resolves.toBeDefined();
  });

  it('keeps a write Operation already on when someone without the permission edits the Events', async () => {
    await setSettings({ operations: ['send_message'] });

    const listed = await setSettings({ operations: ['send_message'], receive: ['message.received'] }, false);

    expect(listed.find((skill) => skill.skillId === serviceSkillId)?.serviceSettings).toEqual({
      operations: ['send_message'],
      receive: ['message.received'],
    });
  });

  it('refuses names the service does not declare', async () => {
    await expect(setSettings({ operations: ['delete_everything'] })).rejects.toMatchObject({
      response: { code: 'bad_request', message: expect.stringContaining('delete_everything') },
    });
  });

  it("shows the saved settings on the Agent's Skills and drops them with the Service skill", async () => {
    await setSettings({ operations: ['send_message'], receive: [] });
    const listed = await profiles().listSkills(agent, managerCaller());
    expect(listed.find((skill) => skill.skillId === serviceSkillId)?.serviceSettings).toEqual({
      operations: ['send_message'],
      receive: [],
    });
    const view = await profiles().serviceSettings(agent, managerCaller(), serviceSkillId);
    expect(view.service).toMatchObject({ id: serviceId, slug: KEYS_SERVICE });
    expect(Object.keys(view.service.manifest.operations ?? {})).toEqual(['send_message']);

    await profiles().removeSkill(agent, managerCaller(), serviceSkillId);
    await profiles().setSkill(agent, managerCaller(), serviceSkillId, {});

    const again = await profiles().listSkills(agent, managerCaller());
    expect(again.find((skill) => skill.skillId === serviceSkillId)?.serviceSettings).toBeNull();
  });

  it('refuses service settings on a Built-in Agent', async () => {
    const builtIn = await agentRow(await ensureBuiltInAgent('app-builder'));
    await expect(setSettings({ operations: [] }, true, builtIn)).rejects.toMatchObject({
      response: { code: 'built_in_agent' },
    });
  });

  it('snapshots the settings at creation: later changes leave existing Projects alone', async () => {
    await setSettings({ operations: ['send_message'], receive: ['message.received'] });
    const before = await createProjectOfAgent();

    await setSettings({ operations: [], receive: [] });
    const after = await createProjectOfAgent();

    expect((await readConfiguration(before)).json().projectConfiguration).toMatchObject({
      operations: { send_message: true },
      receive: { 'message.received': true },
    });
    expect((await readConfiguration(after)).json().projectConfiguration).toMatchObject({
      saved: true,
      operations: { send_message: false },
      receive: { 'message.received': false },
    });
  });

  it('ignores Operation names the settings hold that the service no longer has', async () => {
    await storeSettingsDirectly({ operations: ['send_message', 'retired_operation'], receive: [] });

    const projectId = await createProjectOfAgent();

    expect((await readConfiguration(projectId)).json().projectConfiguration.operations).toEqual({
      send_message: true,
    });
  });

  it('leaves a new Project unconfigured when the Agent has no settings for the service', async () => {
    const projectId = await createProjectOfAgent();

    expect((await readConfiguration(projectId)).json().projectConfiguration.saved).toBe(false);
  });

  it('keeps the configuration with a "Saved, but" failure to Retry when the save hook fails, and creates the Project', async () => {
    const keysManifest = JSON.parse(
      readFileSync(path.join(generatingBuiltInsDir, KEYS_SERVICE, 'service.json'), 'utf8')
    ) as Record<string, unknown>;
    const servicePod: ServicePodFixture = await dispatchToFakePod(app, KEYS_SERVICE, { manifest: keysManifest });
    try {
      servicePod.pod.scriptHook('onProjectConfigurationSaved', () => {
        throw new ServiceError({ status: 409, code: 'address-in-use', detail: 'The provider already routes it.' });
      });
      await setSettings({ operations: ['send_message'], receive: ['message.received'] });

      const projectId = await createProjectOfAgent();

      const view = (await readConfiguration(projectId)).json();
      expect(view.projectConfiguration.saved).toBe(true);
      expect(view.hookFailure).toMatchObject({ code: 'address-in-use' });
    } finally {
      await servicePod.stop();
    }
  });

  it("configures the Agent's Test Project from its settings", async () => {
    await setSettings({ operations: ['send_message'], receive: [] });
    const project = await app
      .get(ProjectService)
      .create({ agentId: agent.id }, tenant.tenantId, { createdBy: manager.userId, kind: TEST_PROJECT_KIND });

    expect((await readConfiguration(project.id)).json().projectConfiguration).toMatchObject({
      saved: true,
      operations: { send_message: true },
    });
  });

  it('configures a Duplicated or Imported Project of the Agent once its files are in place', async () => {
    const source = await createProjectOfAgent();
    await setSettings({ operations: ['send_message'], receive: [] });
    const copy = await app.get(ProjectService).duplicate(source, tenant.tenantId, undefined, manager.userId);

    await app.get(ProjectService).configureCopiedProject(copy.id);

    expect((await readConfiguration(copy.id)).json().projectConfiguration).toMatchObject({
      saved: true,
      operations: { send_message: true },
    });
    expect(recordedHook(`hooks/project/${copy.id}`)).toMatchObject({ previous: null });
  });

  it("delivers a copied Project's Service skill before its save hook runs", async () => {
    const keysManifest = JSON.parse(
      readFileSync(path.join(generatingBuiltInsDir, KEYS_SERVICE, 'service.json'), 'utf8')
    ) as Record<string, unknown>;
    const servicePod: ServicePodFixture = await dispatchToFakePod(app, KEYS_SERVICE, { manifest: keysManifest });
    try {
      const source = await createProjectOfAgent();
      await setSettings({ operations: ['send_message'], receive: [] });
      const copy = await app.get(ProjectService).duplicate(source, tenant.tenantId, undefined, manager.userId);
      const copiedSkill = path.join(
        storageMountPath,
        'projects',
        copy.id,
        '.opencode/skills',
        SERVICE_SKILL,
        'SKILL.md'
      );
      const skillOnDiskAtHook: boolean[] = [];
      servicePod.pod.scriptHook('onProjectConfigurationSaved', () => {
        skillOnDiskAtHook.push(existsSync(copiedSkill));
        return undefined;
      });

      await app.get(ProjectService).configureCopiedProject(copy.id);

      expect(skillOnDiskAtHook).toEqual([true]);
    } finally {
      await servicePod.stop();
    }
  });

  it('copies the settings to Production with the Skill pins on Publish', async () => {
    const production = await productionEnvironmentId(tenant.tenantId);
    await setSettings({ operations: ['send_message'], receive: [] });
    await profiles().publish(agent, managerCaller(), { environmentId: production });

    await setSettings({ operations: ['send_message'], receive: ['message.received'] });
    const published = await profiles().publish(agent, managerCaller(), { environmentId: production });

    expect(published.applied.serviceSettings).toEqual([SERVICE_SKILL]);
    expect(await storedSettingsOf(agent.id, production)).toEqual({
      operations: ['send_message'],
      receive: ['message.received'],
    });
  });

  function carriedSettings(detail: AgentDetail) {
    return detail.profiles.flatMap((profile) => profile.skills ?? []).find((skill) => skill.skillId === serviceSkillId)
      ?.serviceSettings;
  }

  const writesTurnedOff = expect.objectContaining({
    kind: 'skill',
    name: SERVICE_SKILL,
    message: expect.stringMatching(/`send_message`.*can_configure_project_external_services/),
  });

  it('carries the settings on Agent Duplicate', async () => {
    await setSettings({ operations: ['send_message'], receive: ['message.received'] });

    const copy = await app
      .get(AgentService)
      .duplicate(managerCaller(), agent.id, { displayName: 'Copied keys agent' }, { canConfigureProjects: true });

    expect(carriedSettings(copy.agent)).toEqual({ operations: ['send_message'], receive: ['message.received'] });
    expect(copy.notes).toEqual([]);
  });

  it('turns write Operations off on Agent Duplicate without the project-configuration permission, saying so', async () => {
    await setSettings({ operations: ['send_message'], receive: ['message.received'] });

    const copy = await app
      .get(AgentService)
      .duplicate(managerCaller(), agent.id, { displayName: 'Read-only keys agent' }, { canConfigureProjects: false });

    expect(carriedSettings(copy.agent)).toEqual({ operations: [], receive: ['message.received'] });
    expect(copy.notes).toEqual([writesTurnedOff]);
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
      return app.get(AgentImportService).import(caller, archive, null, { canConfigureProjects });
    }

    it("carries the settings by name and drops the names the importing Organization's service lacks", async () => {
      await storeSettingsDirectly({ operations: ['send_message', 'retired_operation'], receive: ['message.received'] });
      const archive = await exportedArchive();

      const imported = await importAs(await importer(), archive);

      expect(carriedSettings(imported.agent)).toEqual({ operations: ['send_message'], receive: ['message.received'] });
      expect(imported.notes).toContainEqual(
        expect.objectContaining({
          kind: 'skill',
          name: SERVICE_SKILL,
          message: expect.stringContaining('retired_operation'),
        })
      );
      expect(imported.notes).not.toContainEqual(writesTurnedOff);
    });

    it('turns write Operations off without the project-configuration permission, saying so in the notes', async () => {
      await setSettings({ operations: ['send_message'], receive: ['message.received'] });
      const archive = await exportedArchive();

      const imported = await importAs(await importer(), archive, false);

      expect(carriedSettings(imported.agent)).toEqual({ operations: [], receive: ['message.received'] });
      expect(imported.notes).toContainEqual(writesTurnedOff);
    });

    it("drops a service that isn't Available in the importing Organization, saying so", async () => {
      await setSettings({ operations: ['send_message'], receive: [] });
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
    await setSettings({ operations: ['send_message'], receive: [] });
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
