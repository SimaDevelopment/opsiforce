import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agents, externalServiceProjectConfigs, skills } from '../../db/schema';
import { AgentExportService } from '../../src/agent/agent-export.service';
import { AgentImportService } from '../../src/agent/agent-import.service';
import { AgentProfileService } from '../../src/agent/agent-profile.service';
import { AgentService } from '../../src/agent/agent.service';
import type { AgentCaller, AgentDetail, AgentRow } from '../../src/agent/agent.types';
import { ProjectService } from '../../src/project/project.service';
import { seedLiveAgent } from '../support/agent-fixtures';
import { addMember, type MemberFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin, type PersonFixture } from './support/fixtures';
import {
  freePort,
  publishCustomService,
  saveCustomServiceConfiguration,
  type PublishedService,
} from './support/published-services';

const REPOSITORIES_MANIFEST = {
  sdk: 2,
  displayName: 'Fixture Repositories',
  description: 'A pretend code host the Organization reaches through its own service.',
  serviceForm: [{ key: 'apiToken', type: 'secret', label: 'API token', required: true }],
  projectForm: [
    { key: 'repositories', type: 'multiselect', label: 'Repositories', options: { call: 'repositories' } },
    { key: 'pullRequests', type: 'toggle', label: 'Open pull requests', default: false },
    { key: 'pullRequestsPerDay', type: 'number', label: 'Pull requests a day', default: 1 },
    {
      key: 'access',
      type: 'select',
      label: 'Access',
      options: [
        { value: 'read', label: 'Read' },
        { value: 'write', label: 'Write' },
      ],
      default: 'read',
    },
    { key: 'webhookToken', type: 'text', label: 'Webhook token', generate: { length: 16, alphabet: 'alphanumeric' } },
  ],
  events: { 'issue.opened': { title: 'Issue opened', description: 'Someone opened an issue.' } },
};

function settingsOf(detail: AgentDetail, skillId: string) {
  return detail.profiles.flatMap((profile) => profile.skills ?? []).find((skill) => skill.skillId === skillId)
    ?.serviceSettings;
}

describe("a Custom Agent's service settings for an SDK 2 service", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let storageRoot: string;
  let admin: PersonFixture;
  let manager: MemberFixture;
  let service: PublishedService;
  let agent: AgentRow;
  let serviceSkillId: string;

  beforeAll(async () => {
    await ensureExternalServiceBuilder();
    storageRoot = await mkdtemp(join(tmpdir(), 'agent-service-settings-values-'));
    harness = await createExternalServicesTestApp({
      env: { STORAGE_MOUNT_PATH: storageRoot },
      servicePodPort: await freePort(),
      serviceStartHoldMs: 200,
    });
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    admin = await tenantAdmin(app);
    service = await publishCustomService(app, admin, storageRoot, {
      slug: `repositories-${crypto.randomUUID().slice(0, 8)}`,
      manifest: REPOSITORIES_MANIFEST,
    });
    const saved = await saveCustomServiceConfiguration(app, admin, service.id, { apiToken: 'repositories-token' });
    expect(saved.statusCode, saved.body).toBe(200);
    manager = await addMember(app, admin.tenant, ['can_manage_agents', 'can_configure_project_external_services']);
    const seeded = await seedLiveAgent(admin.tenant.tenantId, manager.userId);
    const [row] = await db.select().from(agents).where(eq(agents.id, seeded.id));
    agent = { ...row, disabled: false };
    const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.externalServiceId, service.id));
    serviceSkillId = skill.id;
    await profiles().setSkill(agent, managerCaller(), serviceSkillId, {});
  });

  function profiles(): AgentProfileService {
    return app.get(AgentProfileService);
  }

  function managerCaller(): AgentCaller {
    return { tenantId: admin.tenant.tenantId, userId: manager.userId, canManageAgents: true };
  }

  function setSettings(values: unknown, canConfigureProjects = true) {
    return profiles().setServiceSettings(agent, managerCaller(), serviceSkillId, { values }, { canConfigureProjects });
  }

  async function createProjectOfAgent(): Promise<string> {
    const project = await app
      .get(ProjectService)
      .create({ agentId: agent.id }, admin.tenant.tenantId, { createdBy: manager.userId });
    return project.id;
  }

  async function readConfiguration(projectId: string) {
    const view = await app.inject({
      method: 'GET',
      url: `/api/external-services/projects/${projectId}/environments/${projectId}/services/${service.id}`,
      headers: manager.headers,
    });
    expect(view.statusCode, view.body).toBe(200);
    return view.json().projectConfiguration;
  }

  async function storedValues(projectId: string) {
    const [row] = await db
      .select({ values: externalServiceProjectConfigs.values })
      .from(externalServiceProjectConfigs)
      .where(
        and(
          eq(externalServiceProjectConfigs.externalServiceId, service.id),
          eq(externalServiceProjectConfigs.projectEnvironmentId, projectId)
        )
      );
    return row?.values;
  }

  it("writes a new Project's configuration from the settings over the form's defaults, with no Operation or Receive switches", async () => {
    await setSettings({ pullRequests: true, pullRequestsPerDay: 3 });

    const projectId = await createProjectOfAgent();

    const configuration = await readConfiguration(projectId);
    expect(configuration).toMatchObject({
      saved: true,
      missing: [],
      values: { pullRequests: true, pullRequestsPerDay: 3, access: 'read', webhookToken: expect.any(String) },
    });
    const stored = await storedValues(projectId);
    expect(stored).not.toHaveProperty('operations');
    expect(stored).not.toHaveProperty('receive');
  });

  it('ignores a name the service no longer declares when it writes the configuration', async () => {
    await db
      .update(agentProfileSkills)
      .set({ serviceSettings: { pullRequests: true, retiredSetting: 'kept?' } })
      .where(eq(agentProfileSkills.skillId, serviceSkillId));

    const projectId = await createProjectOfAgent();

    const configuration = await readConfiguration(projectId);
    expect(configuration.values).toMatchObject({ pullRequests: true });
    expect(await storedValues(projectId)).not.toHaveProperty('retiredSetting');
  });

  function carriedSettings(detail: AgentDetail) {
    return settingsOf(detail, serviceSkillId);
  }

  const settingsLeftOut = expect.objectContaining({
    kind: 'skill',
    message: expect.stringMatching(/service settings.*can_configure_project_external_services/),
  });

  it('carries the settings on Agent Duplicate', async () => {
    await setSettings({ pullRequests: true, pullRequestsPerDay: 2 });

    const copy = await app
      .get(AgentService)
      .duplicate(managerCaller(), agent.id, { displayName: 'Copied reviewer' }, { canConfigureProjects: true });

    expect(carriedSettings(copy.agent)).toEqual({ pullRequests: true, pullRequestsPerDay: 2 });
    expect(copy.notes).toEqual([]);
  });

  it('drops the settings on Agent Duplicate without the project-configuration permission, saying so', async () => {
    await setSettings({ pullRequests: true });

    const copy = await app
      .get(AgentService)
      .duplicate(managerCaller(), agent.id, { displayName: 'Unconfigured reviewer' }, { canConfigureProjects: false });

    expect(carriedSettings(copy.agent)).toBeNull();
    expect(copy.notes).toEqual([settingsLeftOut]);
  });

  describe('Agent Export and Import', () => {
    async function exportedArchive(): Promise<string> {
      const exported = await app.get(AgentExportService).export(managerCaller(), agent.id);
      const file = join(storageRoot, `${crypto.randomUUID()}.zip`);
      await writeFile(file, exported.archive);
      return file;
    }

    async function importerWithService(projectForm: unknown[]): Promise<{ caller: AgentCaller; skillId: string }> {
      const importingAdmin = await tenantAdmin(app);
      const here = await publishCustomService(app, importingAdmin, storageRoot, {
        slug: service.slug,
        manifest: { ...REPOSITORIES_MANIFEST, projectForm },
      });
      await saveCustomServiceConfiguration(app, importingAdmin, here.id, { apiToken: 'here-token' });
      const member = await addMember(app, importingAdmin.tenant, ['can_manage_agents', 'can_manage_skills']);
      const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.externalServiceId, here.id));
      return {
        caller: { tenantId: importingAdmin.tenant.tenantId, userId: member.userId, canManageAgents: true },
        skillId: skill.id,
      };
    }

    it("carries the settings by field key and drops the keys the importing Organization's service lacks", async () => {
      await setSettings({ pullRequests: true, pullRequestsPerDay: 2 });
      const archive = await exportedArchive();
      const importer = await importerWithService(
        REPOSITORIES_MANIFEST.projectForm.filter((field) => field.key !== 'pullRequestsPerDay')
      );

      const imported = await app
        .get(AgentImportService)
        .import(importer.caller, archive, { displayName: null, projectSettings: {} }, { canConfigureProjects: true });

      expect(settingsOf(imported.agent, importer.skillId)).toEqual({ pullRequests: true });
      expect(imported.notes).toContainEqual(
        expect.objectContaining({ kind: 'skill', message: expect.stringContaining('pullRequestsPerDay') })
      );
    });

    it('drops the settings without the project-configuration permission, saying so', async () => {
      await setSettings({ pullRequests: true });
      const archive = await exportedArchive();
      const importer = await importerWithService(REPOSITORIES_MANIFEST.projectForm);

      const imported = await app
        .get(AgentImportService)
        .import(importer.caller, archive, { displayName: null, projectSettings: {} }, { canConfigureProjects: false });

      expect(settingsOf(imported.agent, importer.skillId)).toBeNull();
      expect(imported.notes).toContainEqual(settingsLeftOut);
    });
  });

  it('refuses any setting without the project-configuration permission, naming it', async () => {
    await expect(setSettings({ pullRequests: false }, false)).rejects.toMatchObject({
      response: {
        code: 'missing_permission',
        message: expect.stringContaining('can_configure_project_external_services'),
      },
    });
  });

  it('refuses a target, an undeclared name or an unfit value', async () => {
    await expect(setSettings({ repositories: ['acme/web'] })).rejects.toMatchObject({
      response: { code: 'bad_request', message: expect.stringContaining('repositories') },
    });
    await expect(setSettings({ webhookToken: 'chosen' })).rejects.toMatchObject({
      response: { code: 'bad_request', message: expect.stringContaining('webhookToken') },
    });
    await expect(setSettings({ mergeToMain: true })).rejects.toMatchObject({
      response: { code: 'bad_request', message: expect.stringContaining('mergeToMain') },
    });
    await expect(setSettings({ access: 'admin' })).rejects.toMatchObject({
      response: { code: 'bad_request', message: expect.stringContaining('access') },
    });
  });
});
