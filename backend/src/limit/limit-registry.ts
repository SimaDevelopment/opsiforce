import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentSettings, agents, projects } from '../../db/schema';
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

async function countWarmPoolSlots(executor: DbExecutor, tenantId: string): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`coalesce(sum(${agentSettings.warmPoolSize}), 0)::int` })
    .from(agentSettings)
    .innerJoin(agents, eq(agents.id, agentSettings.agentId))
    .where(and(eq(agents.tenantId, tenantId), eq(agents.origin, 'custom')));
  return row?.count ?? 0;
}

export const LIMITS: Record<LimitKey, LimitDefinition> = {
  projects: { noun: 'projects', count: countEnabledOrdinaryProjects },
  warm_pool: { noun: 'Ready Projects across its agents', count: countWarmPoolSlots },
};

export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];

export function isLimitKey(value: string): value is LimitKey {
  return Object.hasOwn(LIMITS, value);
}
