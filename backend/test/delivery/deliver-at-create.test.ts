import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agentProfiles, projectSkillDeliveries, projects, skills } from '../../db/schema';
import { DEFAULT_AGENT_NAME } from '../../src/agent/agent.types';
import type { SkillCaller } from '../../src/store/skill.service';
import {
  defaultEnvironmentId,
  ensureBuiltInAgent,
  ensureBuiltInSkill,
  seedLiveAgent,
  type SeededAgent,
} from '../support/agent-fixtures';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, validDescription } from '../store/support/skill-fixtures';

const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? '';

let harness: DomainTestHarness;
let tenantId: string;
let userId: string;
let caller: SkillCaller;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  tenantId = await createTenantRow();
  userId = await createUserRow();
  caller = { tenantId, userId, canManageSkills: true };
  await harness.environments.ensureDefaultForTenant(tenantId);
});

afterAll(async () => {
  await harness.close();
});

async function seedSkill(name: string, body: string): Promise<{ skillId: string; versionId: string }> {
  const summary = await harness.skills.create(caller, {
    name,
    files: [{ path: 'SKILL.md', content: manifest(`name: ${name}\ndescription: ${validDescription}`, body) }],
  });
  const [row] = await db.select({ versionId: skills.latestVersionId }).from(skills).where(eq(skills.id, summary.id));
  if (!row?.versionId) throw new Error(`Skill ${name} was created without a version`);
  return { skillId: summary.id, versionId: row.versionId };
}

async function pin(agentId: string, environmentId: string, skill: { skillId: string; versionId: string }) {
  const [profile] = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.agentId, agentId), eq(agentProfiles.environmentId, environmentId)));
  await db
    .insert(agentProfileSkills)
    .values({ profileId: profile.id, skillId: skill.skillId, skillVersionId: skill.versionId })
    .onConflictDoNothing();
  return profile.id;
}

async function workspaceFile(projectId: string, ...segments: string[]): Promise<string> {
  return readFile(path.join(storageMountPath, 'projects', projectId, ...segments), 'utf8');
}

async function createProject(agentId: string): Promise<string> {
  const project = await harness.projects.create({ agentId }, tenantId, { createdBy: userId });
  return project.id;
}

describe('a Project created from a Custom Agent', () => {
  let agent: SeededAgent;
  let projectId: string;

  beforeAll(async () => {
    agent = await seedLiveAgent(tenantId, userId);
    const environmentId = await defaultEnvironmentId(tenantId);
    await db
      .update(agentProfiles)
      .set({ promptBody: 'You are Acme Support.', model: 'openai/gpt-5.6-sol', variant: 'high' })
      .where(and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.environmentId, environmentId)));
    await pin(agent.id, environmentId, await seedSkill(`billing-${randomUUID().slice(0, 8)}`, '# Billing\n'));
    projectId = await createProject(agent.id);
  });

  it('boots on that Agent', async () => {
    expect(JSON.parse(await workspaceFile(projectId, '.opencode/opencode.json'))).toMatchObject({
      default_agent: agent.name,
    });
  });

  it('writes the prompt in the only frontmatter form the v2 loader parses', async () => {
    const file = await workspaceFile(projectId, `.opencode/agents/${agent.name}.md`);
    expect(file).toBe(`---\nmodel: openai/gpt-5.6-sol#high\nmode: primary\n---\n\nYou are Acme Support.\n`);
  });

  it('carries the profile’s pinned Skills and records them', async () => {
    const ledger = await db
      .select()
      .from(projectSkillDeliveries)
      .where(eq(projectSkillDeliveries.projectEnvironmentId, projectId));
    expect(ledger).toHaveLength(1);
    expect(await workspaceFile(projectId, `.opencode/skills/${ledger[0].skillName}/SKILL.md`)).toContain('# Billing');
  });

  it('is never re-derived once the Agent moves on', async () => {
    const before = await workspaceFile(projectId, `.opencode/agents/${agent.name}.md`);
    await db.update(agentProfiles).set({ promptBody: 'Rewritten.' }).where(eq(agentProfiles.agentId, agent.id));

    await harness.projects.findOne(projectId, tenantId);

    expect(await workspaceFile(projectId, `.opencode/agents/${agent.name}.md`)).toBe(before);
  });
});

describe('a Project created from a Built-in Agent', () => {
  it('gets the Organization’s Skills but not the names its package already ships', async () => {
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    const environmentId = await defaultEnvironmentId(tenantId);
    await db
      .insert(agentProfiles)
      .values({ id: randomUUID(), agentId, environmentId })
      .onConflictDoNothing({ target: [agentProfiles.agentId, agentProfiles.environmentId] });

    const organizationSkill = `org-${randomUUID().slice(0, 8)}`;
    await pin(agentId, environmentId, await seedSkill(organizationSkill, '# Org\n'));
    const shipped = await ensureBuiltInSkill('platform');
    await pin(agentId, environmentId, { skillId: shipped.skillId, versionId: shipped.versionId });

    const projectId = await createProject(agentId);

    const delivered = await db
      .select({ name: projectSkillDeliveries.skillName })
      .from(projectSkillDeliveries)
      .where(eq(projectSkillDeliveries.projectEnvironmentId, projectId));
    expect(delivered.map((row) => row.name)).toEqual([organizationSkill]);
    expect(await workspaceFile(projectId, `.opencode/skills/${organizationSkill}/SKILL.md`)).toContain('# Org');
    expect(JSON.parse(await workspaceFile(projectId, '.opencode/opencode.json'))).toMatchObject({
      default_agent: DEFAULT_AGENT_NAME,
    });
  });

  it('runs an imported Project under the slug its export carried', async () => {
    const agentId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);
    const projectId = await createProject(agentId);
    await db.update(projects).set({ importedAgent: 'acme-support' }).where(eq(projects.id, projectId));

    expect(await harness.delivery.runtimeAgentSlugFor(projectId)).toBe('acme-support');
  });
});
