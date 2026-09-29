import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import 'reflect-metadata';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfileSkills, agentProfiles, projectSkillDeliveries, skills } from '../../db/schema';
import { runtimeAgentSlug } from '../../src/delivery/runtime-agent-slug';
import type { SkillCaller } from '../../src/store/skill.service';
import { DEFAULT_AGENT_NAME } from '../../src/agent/agent.types';
import { defaultEnvironmentId, ensureBuiltInAgent, seedLiveAgent } from '../support/agent-fixtures';
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

function workspaceFile(directory: string, ...segments: string[]): Promise<string> {
  return readFile(path.join(storageMountPath, directory, ...segments), 'utf8');
}

describe('runtimeAgentSlug', () => {
  it('prefers the slug an import recorded over the row it fell back to', () => {
    expect(runtimeAgentSlug({ importedAgent: 'acme-support', agentName: 'app-builder' })).toBe('acme-support');
    expect(runtimeAgentSlug({ importedAgent: null, agentName: 'app-builder' })).toBe('app-builder');
  });
});

describe('Publish (App) into an empty target', () => {
  it('copies the backend-owned files and the ledger, and leaves them alone on republish', async () => {
    const agent = await seedLiveAgent(tenantId, userId);
    const environmentId = await defaultEnvironmentId(tenantId);
    const skillName = `billing-${randomUUID().slice(0, 8)}`;
    const summary = await harness.skills.create(caller, {
      name: skillName,
      files: [
        { path: 'SKILL.md', content: manifest(`name: ${skillName}\ndescription: ${validDescription}`, '# v1\n') },
      ],
    });
    const [skillRow] = await db
      .select({ versionId: skills.latestVersionId })
      .from(skills)
      .where(eq(skills.id, summary.id));
    if (!skillRow?.versionId) throw new Error(`Skill ${skillName} was created without a version`);
    const [profile] = await db
      .select({ id: agentProfiles.id })
      .from(agentProfiles)
      .where(and(eq(agentProfiles.agentId, agent.id), eq(agentProfiles.environmentId, environmentId)));
    await db
      .update(agentProfiles)
      .set({ promptBody: 'Be helpful.', model: 'openai/gpt-5.6-sol', variant: 'high' })
      .where(eq(agentProfiles.id, profile.id));
    await db
      .insert(agentProfileSkills)
      .values({ profileId: profile.id, skillId: summary.id, skillVersionId: skillRow.versionId });

    const development = await harness.projects.create({ agentId: agent.id }, tenantId, { createdBy: userId });
    const target = { id: randomUUID(), directory: `projects/${randomUUID()}` };
    await harness.projectEnvironments.create({
      ...target,
      projectId: development.id,
      environmentId: null,
      isDefault: false,
      platformVersion: '0.1.0',
    });

    await harness.delivery.copyToNewEnvironment(development.id, target.id);

    expect(JSON.parse(await workspaceFile(target.directory, '.opencode/opencode.json'))).toEqual({
      default_agent: agent.name,
    });
    expect(await workspaceFile(target.directory, `.opencode/agents/${agent.name}.md`)).toContain('Be helpful.');
    expect(await workspaceFile(target.directory, `.opencode/skills/${skillName}/SKILL.md`)).toContain('# v1');

    const copied = await db
      .select({ name: projectSkillDeliveries.skillName })
      .from(projectSkillDeliveries)
      .where(eq(projectSkillDeliveries.projectEnvironmentId, target.id));
    expect(copied.map((row) => row.name)).toEqual([skillName]);
  });
});

describe('resolving the Agent an archive names', () => {
  it('matches the global Built-in row and this Organization’s own Custom Agent, and nobody else’s', async () => {
    const mine = await seedLiveAgent(tenantId, userId);
    const otherTenantId = await createTenantRow();
    const otherUserId = await createUserRow();
    await harness.environments.ensureDefaultForTenant(otherTenantId);
    const theirs = await seedLiveAgent(otherTenantId, otherUserId);
    const builtInId = await ensureBuiltInAgent(DEFAULT_AGENT_NAME);

    expect(await harness.agents.findIdByName(mine.name, tenantId)).toBe(mine.id);
    expect(await harness.agents.findIdByName(DEFAULT_AGENT_NAME, tenantId)).toBe(builtInId);
    expect(await harness.agents.findIdByName(theirs.name, tenantId)).toBeNull();
  });
});
