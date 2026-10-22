import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { skills, skillVersions } from '../../db/schema';
import { hashSkillTree, validateSkillTree } from '../../src/store/gate';
import { renameSkillsReservedForServices } from '../../src/store/service-skill-names';
import { SkillRepository } from '../../src/store/skill.repository';
import type { SkillCaller } from '../../src/store/skill.service';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import { createTenantRow, createUserRow } from '../support/org-fixtures';
import { manifest, skillFile, validDescription } from './support/skill-fixtures';

let harness: DomainTestHarness;
let caller: SkillCaller;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  const tenantId = await createTenantRow();
  caller = { tenantId, userId: await createUserRow(), canManageSkills: true };
  await harness.environments.ensureDefaultForTenant(tenantId);
});

afterAll(async () => {
  await harness.close();
});

function treeNamed(name: string) {
  return [skillFile('SKILL.md', manifest(`name: ${name}\ndescription: ${validDescription}`, '# Legacy\n'))];
}

describe('a Store Skill name starting with service-', () => {
  it('is refused, because Service skills own that prefix', async () => {
    const name = `service-${randomUUID().slice(0, 8)}`;

    await expect(
      harness.skills.create(caller, {
        name,
        files: [{ path: 'SKILL.md', content: treeNamed(name)[0].content.toString() }],
      })
    ).rejects.toMatchObject({
      response: { code: 'name_unavailable' },
    });
  });

  it('is renamed once at boot when a Store Skill already has one, with every Version’s manifest following', async () => {
    const name = `service-${randomUUID().slice(0, 8)}`;
    const tree = treeNamed(name);
    const { skillId, versionId } = await harness.moduleRef.get(SkillRepository).createSkillWithFirstVersion({
      tenantId: caller.tenantId,
      userId: caller.userId,
      name,
      displayName: null,
      createdByProjectId: null,
      description: validDescription,
      tree,
      contentHash: hashSkillTree(tree),
      flags: { has_executables: false },
      lints: [],
      createdVia: 'form',
      sourceRef: null,
    });

    await renameSkillsReservedForServices();

    const [renamed] = await db.select({ name: skills.name }).from(skills).where(eq(skills.id, skillId));
    expect(renamed.name).toBe(`store-${name}`);
    const stored = await harness.moduleRef.get(SkillRepository).readTree(versionId);
    expect(validateSkillTree(stored, { expectedName: `store-${name}` }).errors).toEqual([]);
    const [version] = await db
      .select({ contentHash: skillVersions.contentHash })
      .from(skillVersions)
      .where(eq(skillVersions.id, versionId));
    expect(version.contentHash).toBe(hashSkillTree(stored));

    await renameSkillsReservedForServices();
    const [again] = await db.select({ name: skills.name }).from(skills).where(eq(skills.id, skillId));
    expect(again.name).toBe(`store-${name}`);
  });
});
