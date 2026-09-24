import { NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { skills, tenantDisabledSkills } from '../../db/schema';
import { PLATFORM_SKILL_NAME } from '../agent/agent.types';

export type SkillRow = typeof skills.$inferSelect & { disabled: boolean };

export function skillDisabledIn(tenantId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${tenantDisabledSkills}
    where ${tenantDisabledSkills.skillId} = ${skills.id} and ${tenantDisabledSkills.tenantId} = ${tenantId}
  )`;
}

export function skillColumnsIn(tenantId: string) {
  return { ...getTableColumns(skills), disabled: skillDisabledIn(tenantId) };
}

export interface VisibilityOptions {
  includeDisabled?: boolean;
}

export function visibleSkillsWhere(tenantId: string, userId: string, options: VisibilityOptions = {}): SQL | undefined {
  const scoped = or(
    and(isNull(skills.tenantId), eq(skills.origin, 'built_in')),
    and(eq(skills.tenantId, tenantId), or(eq(skills.visibility, 'public'), eq(skills.createdBy, userId)))
  );
  return options.includeDisabled ? scoped : and(scoped, not(skillDisabledIn(tenantId)));
}

export async function findVisibleSkill(
  tenantId: string,
  userId: string,
  skillId: string
): Promise<SkillRow | undefined> {
  const [row] = await db
    .select(skillColumnsIn(tenantId))
    .from(skills)
    .where(and(eq(skills.id, skillId), visibleSkillsWhere(tenantId, userId, { includeDisabled: true })))
    .limit(1);
  return row;
}

export async function assertSkillVisibleToUser(tenantId: string, userId: string, skillId: string): Promise<SkillRow> {
  const row = await findVisibleSkill(tenantId, userId, skillId);
  if (!row) throw new NotFoundException(`Skill ${skillId} not found`);
  return row;
}

export function canDisableSkill(skill: SkillRow, userId: string): boolean {
  return skill.origin === 'custom' ? canEditSkill(skill, userId) : skill.name !== PLATFORM_SKILL_NAME;
}

export function canEditSkill(skill: SkillRow, userId: string): boolean {
  return skill.origin === 'custom' && (skill.visibility === 'public' || skill.createdBy === userId);
}
