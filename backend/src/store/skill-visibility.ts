import { NotFoundException } from '@nestjs/common';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { skills } from '../../db/schema';

export type SkillRow = typeof skills.$inferSelect;

export interface VisibilityOptions {
  includeArchived?: boolean;
}

export function visibleSkillsWhere(tenantId: string, userId: string, options: VisibilityOptions = {}): SQL | undefined {
  const scoped = or(
    and(isNull(skills.tenantId), eq(skills.origin, 'built_in')),
    and(eq(skills.tenantId, tenantId), or(eq(skills.visibility, 'public'), eq(skills.createdBy, userId)))
  );
  return options.includeArchived ? scoped : and(scoped, eq(skills.archived, false));
}

export async function findVisibleSkill(
  tenantId: string,
  userId: string,
  skillId: string
): Promise<SkillRow | undefined> {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), visibleSkillsWhere(tenantId, userId, { includeArchived: true })))
    .limit(1);
  return row;
}

export async function assertSkillVisibleToUser(tenantId: string, userId: string, skillId: string): Promise<SkillRow> {
  const row = await findVisibleSkill(tenantId, userId, skillId);
  if (!row) throw new NotFoundException(`Skill ${skillId} not found`);
  return row;
}

export function canEditSkill(skill: SkillRow, userId: string): boolean {
  return skill.origin === 'custom' && (skill.visibility === 'public' || skill.createdBy === userId);
}
