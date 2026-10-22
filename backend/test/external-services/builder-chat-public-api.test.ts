import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import {
  agentProfileSkills,
  agentProfiles,
  externalServices,
  projectSkillDeliveries,
  skills,
  type AgentServiceSettings,
} from '../../db/schema';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import { BuilderChatService } from '../../src/builder/builder-chat.service';
import { BuilderModule } from '../../src/builder/builder.module';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { ServiceSkillReach } from '../../src/external-services/knowledge/service-skill-reach';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { Perms } from '../../src/permission/permission.constants';
import { ensureBuiltInAgent, seedLiveAgent, seedWorkspaceProject } from '../support/agent-fixtures';
import {
  addMember,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { createCustomService, ensureExternalServiceBuilder } from './support/custom-services';
import { tenantAdmin } from './support/fixtures';
import { readProjectConfiguration, storedProjectConfiguration, storeProjectConfiguration } from './support/gate';

const PUBLIC_API = 'public-api';

const MIGRATIONS = join(__dirname, '../../db/migrations');

const BUILDER_CONFIGURATION_STATEMENTS = [
  `INSERT INTO "external_services" ("id", "origin", "slug")\nVALUES (gen_random_uuid()::text, 'built_in', 'public-api')`,
  `INSERT INTO "external_service_project_configs" ("id", "external_service_id", "project_environment_id", "values")\nSELECT gen_random_uuid()::text, "service"."id", "project_environments"."id"`,
];

function statementsOf(migration: string): string[] {
  return readFileSync(join(MIGRATIONS, migration), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim());
}

async function runBuilderConfigurationMigration(): Promise<void> {
  const statements = statementsOf('0076_external-services-v2.sql');
  for (const prefix of BUILDER_CONFIGURATION_STATEMENTS) {
    const statement = statements.find((candidate) => candidate.startsWith(prefix));
    if (!statement) throw new Error(`No migration statement starts with ${prefix}`);
    await db.execute(sql.raw(statement));
  }
}

async function runSettingsMigration(): Promise<void> {
  for (const statement of statementsOf('0080_public-api-settings.sql')) await db.execute(sql.raw(statement));
}

const BUILDER_SETTINGS = {
  authorSkillsAndAgents: true,
  createAgents: false,
  createProjects: true,
  maxCreatedProjects: 5,
  driveCreatedProjects: true,
  deleteCreatedProjects: false,
};

describe('Public API access of Skill & Agent Builder chats', () => {
  let harness: ExternalServicesTestApp;
  let tenant: TenantFixture;
  let creator: MemberFixture;
  let builderId: string;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({
      builtInsDir: shippedBuiltInServicesDir(),
      extraModules: [BuilderModule],
    });
    tenant = await createTenant(harness.app);
    creator = await addMember(harness.app, tenant, [Perms.manageSkills, Perms.manageAgents]);
    builderId = await ensureBuiltInAgent(BUILDER_AGENT_SLUG);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('gives a new chat its public-api settings before its first delivery, which lays the Service skill', async () => {
    const skillId = randomUUID();
    await db.insert(skills).values({
      id: skillId,
      tenantId: tenant.tenantId,
      origin: 'custom',
      name: `skill-${skillId.slice(0, 8)}`,
      visibility: 'private',
      createdBy: creator.userId,
    });

    const chat = await harness.app.get(BuilderChatService).openFor(
      {
        tenantId: tenant.tenantId,
        userId: creator.userId,
        canManageSkills: true,
        canManageAgents: true,
        canManageTenantExternalServices: false,
      },
      { skillId }
    );

    const configuration = await readProjectConfiguration(harness.app, PUBLIC_API, chat.id);
    expect(configuration.saved).toBe(true);
    expect(configuration.values).toMatchObject(BUILDER_SETTINGS);
    expect(await storedProjectConfiguration(PUBLIC_API, chat.id)).not.toHaveProperty('operations');
    const delivered = await harness.app.get(DeliveryService).serviceSkillsFor(chat.id);
    expect(delivered.map((skill) => skill.name)).toContain('service-public-api');
    expect(
      await db
        .select({ name: projectSkillDeliveries.skillName })
        .from(projectSkillDeliveries)
        .where(
          and(
            eq(projectSkillDeliveries.projectEnvironmentId, chat.id),
            eq(projectSkillDeliveries.skillName, 'service-public-api')
          )
        )
    ).toHaveLength(1);
  });

  it('gives an External Service Builder chat no public-api configuration', async () => {
    await ensureExternalServiceBuilder();
    const admin = await tenantAdmin(harness.app);

    const service = await createCustomService(harness.app, admin, 'Ticket desk', `desk-${randomUUID().slice(0, 6)}`);

    expect(await storedProjectConfiguration(PUBLIC_API, service.builderChatId)).toBeNull();
  });

  describe('a chat that existed before the upgrade', () => {
    let unconfigured: string;

    beforeAll(async () => {
      unconfigured = await seedWorkspaceProject(tenant.tenantId, {
        agentId: builderId,
        createdBy: creator.userId,
        kind: 'agent_builder_chat',
      });

      await runBuilderConfigurationMigration();
      await runSettingsMigration();
    });

    it('ends with the builder settings once both migrations ran', async () => {
      const stored = await storedProjectConfiguration(PUBLIC_API, unconfigured);

      expect(stored).toMatchObject(BUILDER_SETTINGS);
      expect(stored).not.toHaveProperty('operations');
      expect(stored).not.toHaveProperty('receive');
    });

    it('is named by the boot pass, which delivers the Service skill it is missing', async () => {
      expect(await harness.app.get(ServiceSkillReach).staleEnvironments()).toContain(unconfigured);
      expect(
        (await harness.app.get(DeliveryService).serviceSkillsFor(unconfigured)).map((skill) => skill.name)
      ).toContain('service-public-api');
    });
  });
});

describe('the one-time migration of stored public-api Operation switches', () => {
  let harness: ExternalServicesTestApp;
  let tenant: TenantFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: shippedBuiltInServicesDir() });
    tenant = await createTenant(harness.app);
  });

  afterAll(async () => {
    await harness.close();
  });

  async function migrated(operations: Record<string, boolean>): Promise<Record<string, unknown> | null> {
    const projectEnvironmentId = await createProject(harness.app, tenant);
    await storeProjectConfiguration(PUBLIC_API, projectEnvironmentId, { operations, receive: {}, _labels: {} });
    await runSettingsMigration();
    return storedProjectConfiguration(PUBLIC_API, projectEnvironmentId);
  }

  it('turns a setting on when any one of its old Operations was on', async () => {
    expect(await migrated({ get_me: true, duplicate_skill: true, reset_test_project: true })).toEqual({
      _labels: {},
      authorSkillsAndAgents: true,
      createAgents: false,
      createProjects: false,
      maxCreatedProjects: 5,
      driveCreatedProjects: true,
      deleteCreatedProjects: false,
    });
  });

  it('maps create_agent, create_project and delete_project each onto its own setting', async () => {
    expect(await migrated({ create_agent: true, create_project: true, delete_project: true })).toMatchObject({
      authorSkillsAndAgents: false,
      createAgents: true,
      createProjects: true,
      driveCreatedProjects: false,
      deleteCreatedProjects: true,
    });
  });

  it('leaves every write off for a configuration with reads only, and drops the operations key', async () => {
    const stored = await migrated({ get_me: true, list_projects: true, create_skill: false });

    expect(stored).toMatchObject({
      authorSkillsAndAgents: false,
      createAgents: false,
      createProjects: false,
      maxCreatedProjects: 5,
      driveCreatedProjects: false,
      deleteCreatedProjects: false,
    });
    expect(stored).not.toHaveProperty('operations');
  });

  it('leaves an already migrated configuration as it is', async () => {
    const projectEnvironmentId = await createProject(harness.app, tenant);
    const settings = { ...BUILDER_SETTINGS, maxCreatedProjects: 9 };
    await storeProjectConfiguration(PUBLIC_API, projectEnvironmentId, settings);

    await runSettingsMigration();

    expect(await storedProjectConfiguration(PUBLIC_API, projectEnvironmentId)).toEqual(settings);
  });
});

describe("the one-time migration of an Agent's Operation switches", () => {
  let harness: ExternalServicesTestApp;
  let tenant: TenantFixture;
  let member: MemberFixture;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp({ builtInsDir: shippedBuiltInServicesDir() });
    tenant = await createTenant(harness.app);
    member = await addMember(harness.app, tenant, [Perms.manageAgents]);
  });

  afterAll(async () => {
    await harness.close();
  });

  async function carriedSkill(
    slug: string,
    settings: AgentServiceSettings
  ): Promise<{ profileId: string; skillId: string }> {
    const agent = await seedLiveAgent(tenant.tenantId, member.userId);
    const [profile] = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agent.id));
    const [skill] = await db
      .select({ id: skills.id, latestVersionId: skills.latestVersionId })
      .from(skills)
      .innerJoin(externalServices, eq(externalServices.id, skills.externalServiceId))
      .where(eq(externalServices.slug, slug));
    if (!profile || !skill?.latestVersionId) throw new Error(`No Agent profile or no Service skill of ${slug}`);
    await db.insert(agentProfileSkills).values({
      profileId: profile.id,
      skillId: skill.id,
      skillVersionId: skill.latestVersionId,
      serviceSettings: settings,
    });
    return { profileId: profile.id, skillId: skill.id };
  }

  async function migratedSettings(carried: { profileId: string; skillId: string }) {
    for (const statement of statementsOf('0081_sdk-1-removed.sql')) {
      if (statement.startsWith('UPDATE "agent_profile_skills"')) await db.execute(sql.raw(statement));
    }
    const [row] = await db
      .select({ serviceSettings: agentProfileSkills.serviceSettings })
      .from(agentProfileSkills)
      .where(and(eq(agentProfileSkills.profileId, carried.profileId), eq(agentProfileSkills.skillId, carried.skillId)));
    return row?.serviceSettings;
  }

  it("turns a public-api Agent's switches into the five settings, as for Project configurations", async () => {
    const carried = await carriedSkill(PUBLIC_API, {
      operations: ['get_me', 'duplicate_skill', 'create_project', 'reset_test_project'],
      receive: [],
    });

    expect(await migratedSettings(carried)).toEqual({
      authorSkillsAndAgents: true,
      createAgents: false,
      createProjects: true,
      maxCreatedProjects: 5,
      driveCreatedProjects: true,
      deleteCreatedProjects: false,
    });
  });

  it('leaves every write off for a public-api Agent that had reads only', async () => {
    const carried = await carriedSkill(PUBLIC_API, { operations: ['get_me', 'list_projects'], receive: [] });

    expect(await migratedSettings(carried)).toMatchObject({
      authorSkillsAndAgents: false,
      createAgents: false,
      createProjects: false,
      driveCreatedProjects: false,
      deleteCreatedProjects: false,
    });
  });

  it("drops another service's switches", async () => {
    const carried = await carriedSkill('incoming-email', { operations: [], receive: ['email.received'] });

    expect(await migratedSettings(carried)).toBeNull();
  });
});
