import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectSkillDeliveries, skills } from '../../db/schema';
import { BUILDER_AGENT_SLUG } from '../../src/agent/agent-visibility';
import { BUILDER_CHAT_PUBLIC_API_WRITES, BuilderChatService } from '../../src/builder/builder-chat.service';
import { BuilderModule } from '../../src/builder/builder.module';
import { DeliveryService } from '../../src/delivery/delivery.service';
import { ServiceSkillReach } from '../../src/external-services/knowledge/service-skill-reach';
import { shippedBuiltInServicesDir } from '../../src/external-services/registry/built-in-services';
import { Perms } from '../../src/permission/permission.constants';
import { ensureBuiltInAgent, seedWorkspaceProject } from '../support/agent-fixtures';
import { addMember, createTenant, type MemberFixture, type TenantFixture } from '../support/project-fixtures';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from './support/app';
import { readProjectConfiguration, saveProjectConfiguration } from './support/gate';

const PUBLIC_API = 'public-api';

const MIGRATION = join(__dirname, '../../db/migrations/0076_external-services-v2.sql');

const BUILDER_CONFIGURATION_STATEMENTS = [
  `INSERT INTO "external_services" ("id", "origin", "slug")\nVALUES (gen_random_uuid()::text, 'built_in', 'public-api')`,
  `INSERT INTO "external_service_project_configs" ("id", "external_service_id", "project_environment_id", "values")\nSELECT gen_random_uuid()::text, "service"."id", "project_environments"."id"`,
];

async function runBuilderConfigurationMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim());
  for (const prefix of BUILDER_CONFIGURATION_STATEMENTS) {
    const statement = statements.find((candidate) => candidate.startsWith(prefix));
    if (!statement) throw new Error(`No migration statement starts with ${prefix}`);
    await db.execute(sql.raw(statement));
  }
}

const MIGRATED_OPERATIONS = {
  connect_project: true,
  create_agent: false,
  create_project: true,
  create_skill: true,
  create_skill_version: true,
  delete_project: false,
  duplicate_skill: true,
  get_agent: true,
  get_me: true,
  get_project: true,
  get_skill: true,
  get_skill_files: true,
  list_agent_skills: true,
  list_agents: true,
  list_projects: true,
  list_skills: true,
  remove_agent_skill: true,
  reset_test_project: true,
  restart_project: true,
  save_agent_template: true,
  set_agent_skill: true,
  update_agent: true,
  update_agent_profile: true,
  update_skill: true,
  update_test_project: true,
  validate_skill: true,
};

const manifestOperations = (
  JSON.parse(readFileSync(join(shippedBuiltInServicesDir(), PUBLIC_API, 'service.json'), 'utf8')) as {
    operations: Record<string, { kind?: string }>;
  }
).operations;

const builderSwitches = Object.fromEntries(
  Object.entries(manifestOperations).map(([name, operation]) => [
    name,
    (operation.kind ?? 'read') === 'read' || (BUILDER_CHAT_PUBLIC_API_WRITES as readonly string[]).includes(name),
  ])
);

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

  it('turns on every read and the writes a chat makes, never create_agent or delete_project', () => {
    expect(builderSwitches).toMatchObject({ create_agent: false, delete_project: false, get_me: true });
    expect(Object.values(builderSwitches).filter(Boolean)).toHaveLength(24);
  });

  it('gives a new chat its public-api configuration before its first delivery, which lays the Service skill', async () => {
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
    expect(configuration.operations).toEqual(builderSwitches);
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

  describe('a chat that existed before the upgrade', () => {
    let unconfigured: string;
    let configured: string;

    beforeAll(async () => {
      const seedChat = () =>
        seedWorkspaceProject(tenant.tenantId, {
          agentId: builderId,
          createdBy: creator.userId,
          kind: 'agent_builder_chat',
        });
      unconfigured = await seedChat();
      configured = await seedChat();
      await saveProjectConfiguration(harness.app, PUBLIC_API, configured, { operations: { get_me: true } });

      await runBuilderConfigurationMigration();
    });

    it('gets every read and the fourteen authoring writes on from the migration', async () => {
      const configuration = await readProjectConfiguration(harness.app, PUBLIC_API, unconfigured);

      expect(configuration.saved).toBe(true);
      expect(configuration.operations).toEqual(MIGRATED_OPERATIONS);
    });

    it('keeps a configuration it already had', async () => {
      const configuration = await readProjectConfiguration(harness.app, PUBLIC_API, configured);

      expect(configuration.operations).toMatchObject({ get_me: true, create_skill: false, update_agent: false });
    });

    it('is named by the boot pass, which delivers the Service skill it is missing', async () => {
      expect(await harness.app.get(ServiceSkillReach).staleEnvironments()).toContain(unconfigured);
      expect(
        (await harness.app.get(DeliveryService).serviceSkillsFor(unconfigured)).map((skill) => skill.name)
      ).toContain('service-public-api');
    });
  });
});
