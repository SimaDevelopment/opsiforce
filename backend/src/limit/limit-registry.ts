import { and, eq, isNull, sql } from 'drizzle-orm';
import { projects } from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import type { LimitKey } from './limit.types';

interface LimitDefinition {
  noun: string;
  count: (executor: DbExecutor, tenantId: string) => Promise<number>;
}

async function countEnabledOrdinaryProjects(executor: DbExecutor, tenantId: string): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), isNull(projects.kind), eq(projects.disabled, false)));
  return row?.count ?? 0;
}

export const LIMITS: Record<LimitKey, LimitDefinition> = {
  projects: { noun: 'projects', count: countEnabledOrdinaryProjects },
};

export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];

export function isLimitKey(value: string): value is LimitKey {
  return Object.hasOwn(LIMITS, value);
}
