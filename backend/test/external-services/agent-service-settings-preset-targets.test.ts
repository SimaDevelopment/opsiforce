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
import { DEFAULT_AGENT_NAME, type AgentCaller, type AgentRow } from '../../src/agent/agent.types';
import { ProjectService } from '../../src/project/project.service';
import { developmentEnvironmentId } from '../../src/store/agent-profile.repository';
import { ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
import { addMember, createTenant, type MemberFixture, type TenantFixture } from '../support/project-fixtures';
import {
  createExternalServicesTestApp,
  FIXTURE_SERVICE,
  type ExternalServicesTestApp,
} from '../support/external-services-app';
import { builtInServiceId, forgetPlatformServiceConfiguration } from '../support/external-service-fixtures';
import { configurePlatformService, READY_FIXTURE_CRM } from './support/gate';

const CONFIGURE = ['can_manage_agents', 'can_configure_project_external_services'];

async function agentRow(agentId: string): Promise<AgentRow> {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return { ...row, disabled: false };
}

describe("an Agent's service settings that preset targets", () => {
  let harness: ExternalServicesTestApp;
  let app: NestFastifyApplication;
  let serviceId: string;
  let serviceSkillId: string;
  let tenant: TenantFixture;
  let manager: MemberFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
    app = harness.app;
    serviceId = await builtInServiceId(FIXTURE_SERVICE);
    await forgetPlatformServiceConfiguration(FIXTURE_SERVICE);
    await configurePlatformService(app, FIXTURE_SERVICE, READY_FIXTURE_CRM);
    const [skill] = await db.select({ id: skills.id }).from(skills).where(eq(skills.externalServiceId, serviceId));
    serviceSkillId = skill.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(app);
    manager = await addMember(app, tenant, CONFIGURE);
  });

  function profiles(): AgentProfileService {
    return app.get(AgentProfileService);
  }

  function callerOf(member: MemberFixture, of: TenantFixture = tenant): AgentCaller {
    return { tenantId: of.tenantId, userId: member.userId, canManageAgents: true };
  }

  async function carryingAgent(agentId: string, caller: AgentCaller = callerOf(manager)): Promise<AgentRow> {
    const agent = await agentRow(agentId);
    await profiles().setSkill(agent, caller, serviceSkillId, {});
    return agent;
  }

  async function customAgent(): Promise<AgentRow> {
    return carryingAgent((await seedLiveAgent(tenant.tenantId, manager.userId)).id);
  }

  async function supportMailboxId(agent: AgentRow): Promise<string> {
    const view = await profiles().serviceSettings(agent, callerOf(manager), serviceSkillId, {
      canConfigureProjects: true,
    });
    const mailboxes = view.serviceConfigurationOptions.find((source) => source.list === 'mailboxes');
    const support = mailboxes?.options.find((option) => option.label === 'Support');
    if (!support) throw new Error('The settings view offers no Support mailbox');
    return support.value;
  }

  function setSettings(agent: AgentRow, values: Record<string, unknown>, caller: AgentCaller = callerOf(manager)) {
    return profiles().setServiceSettings(agent, caller, serviceSkillId, { values }, { canConfigureProjects: true });
  }

  async function createProject(agent: AgentRow, member: MemberFixture = manager, of: TenantFixture = tenant) {
    const project = await app
      .get(ProjectService)
      .create({ agentId: agent.id }, of.tenantId, { createdBy: member.userId });
    const view = await app.inject({
      method: 'GET',
      url: `/api/external-services/projects/${project.id}/environments/${project.id}/services/${serviceId}`,
      headers: member.headers,
    });
    expect(view.statusCode, view.body).toBe(200);
    return view.json().projectConfiguration;
  }

  function askAccounts(agent: AgentRow, query: string, canConfigureProjects = true) {
    return profiles().serviceSettingsOptions(
      agent,
      callerOf(manager),
      serviceSkillId,
      'listAccounts',
      { values: {}, query },
      { canConfigureProjects }
    );
  }

  it('lists a Project-form choice from the service with no Project, for the Agent page', async () => {
    const agent = await customAgent();

    const answer = await askAccounts(agent, 'glo');

    expect(answer.status).toBe(200);
    expect(JSON.parse(Buffer.from(answer.body).toString('utf8'))).toEqual([{ value: 'acc_2', label: 'Globex' }]);
  });

  it('keeps every choice from someone who may not configure Projects', async () => {
    const agent = await customAgent();

    await expect(askAccounts(agent, '', false)).rejects.toMatchObject({
      response: { permission: 'can_configure_project_external_services' },
    });
    const view = await profiles().serviceSettings(agent, callerOf(manager), serviceSkillId, {
      canConfigureProjects: false,
    });
    expect(view.serviceConfigurationOptions).toEqual([]);
  });

  it('keeps every choice from someone who may not edit the Agent', async () => {
    const agent = await carryingAgent(
      (await seedLiveAgent(tenant.tenantId, manager.userId, { visibility: 'private' })).id
    );
    const colleague = callerOf(await addMember(app, tenant, CONFIGURE));

    await expect(
      profiles().serviceSettingsOptions(
        agent,
        colleague,
        serviceSkillId,
        'listAccounts',
        { values: {} },
        {
          canConfigureProjects: true,
        }
      )
    ).rejects.toMatchObject({ response: { code: 'not_editable' } });
    const view = await profiles().serviceSettings(agent, colleague, serviceSkillId, { canConfigureProjects: true });
    expect(view.serviceConfigurationOptions).toEqual([]);
  });

  it('starts every new Project with the picked targets and their labels, ready without a person', async () => {
    const agent = await customAgent();
    const mailbox = await supportMailboxId(agent);
    await setSettings(agent, {
      mailbox,
      accountIds: ['acc_1'],
      pipeline: 'sales',
      _labels: { accountIds: { acc_1: 'Example Org' }, retired: { x: 'X' } },
    });

    const configuration = await createProject(agent);

    expect(configuration).toMatchObject({
      saved: true,
      missing: [],
      values: { mailbox, accountIds: ['acc_1'], pipeline: 'sales' },
      labels: { accountIds: { acc_1: 'Example Org' } },
    });
    expect(configuration.labels).not.toHaveProperty('retired');
  });

  it('clears the settings so new Projects start unconfigured again, and says whether the service connects them anyway', async () => {
    const agent = await customAgent();
    await setSettings(agent, { pipeline: 'sales' });

    const skills = await profiles().setServiceSettings(
      agent,
      callerOf(manager),
      serviceSkillId,
      { values: null },
      { canConfigureProjects: true }
    );

    expect(skills.find((skill) => skill.skillId === serviceSkillId)).toMatchObject({
      serviceSettings: null,
      serviceConnectedByDefault: false,
    });
    expect(await createProject(agent)).toMatchObject({ saved: false, values: {} });
  });

  it('refuses a secret: each Project keeps its own', async () => {
    const agent = await customAgent();

    await expect(setSettings(agent, { signingSecret: 'shared-secret-value' })).rejects.toMatchObject({
      response: { message: expect.stringContaining('signingSecret') },
    });
  });

  it("gives a Built-in Agent settings per Organization: only that Organization's new Projects start from them", async () => {
    const builtIn = await carryingAgent(await ensureBuiltInAgent(DEFAULT_AGENT_NAME));
    const mailbox = await supportMailboxId(builtIn);
    await setSettings(builtIn, { mailbox, pipeline: 'support' });
    const other = await createTenant(app);
    const otherManager = await addMember(app, other, CONFIGURE);
    await profiles().setSkill(builtIn, callerOf(otherManager, other), serviceSkillId, {});

    expect(await createProject(builtIn)).toMatchObject({ saved: true, values: { mailbox, pipeline: 'support' } });
    expect(await createProject(builtIn, otherManager, other)).toMatchObject({ saved: false });
  });

  it('leaves the targets out of an Agent Export and carries the other settings', async () => {
    const agent = await customAgent();
    await setSettings(agent, {
      mailbox: await supportMailboxId(agent),
      accountIds: ['acc_1'],
      pipeline: 'sales',
      _labels: { accountIds: { acc_1: 'Example Org' } },
    });
    const scratch = await mkdtemp(path.join(tmpdir(), 'agent-service-targets-'));
    try {
      const archive = path.join(scratch, 'agent.zip');
      await writeFile(archive, (await app.get(AgentExportService).export(callerOf(manager), agent.id)).archive);
      const target = await createTenant(app);
      const importerMember = await addMember(app, target, [...CONFIGURE, 'can_manage_skills']);

      const imported = await app
        .get(AgentImportService)
        .import(
          callerOf(importerMember, target),
          archive,
          { displayName: null, projectSettings: {} },
          { canConfigureProjects: true }
        );

      const [row] = await db
        .select({ serviceSettings: agentProfileSkills.serviceSettings })
        .from(agentProfileSkills)
        .innerJoin(agentProfiles, eq(agentProfiles.id, agentProfileSkills.profileId))
        .where(
          and(
            eq(agentProfiles.agentId, imported.agent.id),
            eq(agentProfiles.environmentId, await developmentEnvironmentId(target.tenantId)),
            eq(agentProfileSkills.skillId, serviceSkillId)
          )
        );
      expect(row?.serviceSettings).toEqual({ pipeline: 'sales' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
