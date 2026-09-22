import { NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfiles, agentSettings, agents } from '../../db/schema';
import { readMergedAgentRegistry } from './agent-config';

export const BUILDER_AGENT_SLUG = 'skill-agent-builder';

export type AgentRow = typeof agents.$inferSelect;

export interface VisibilityOptions {
  includeArchived?: boolean;
}

export function visibleAgentsWhere(tenantId: string, userId: string, options: VisibilityOptions = {}): SQL | undefined {
  const scoped = or(
    and(isNull(agents.tenantId), eq(agents.origin, 'built_in')),
    and(eq(agents.tenantId, tenantId), or(eq(agents.visibility, 'public'), eq(agents.createdBy, userId)))
  );
  return options.includeArchived ? scoped : and(scoped, eq(agents.archived, false));
}

export async function findVisibleAgent(
  tenantId: string,
  userId: string,
  agentId: string
): Promise<AgentRow | undefined> {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), visibleAgentsWhere(tenantId, userId, { includeArchived: true })))
    .limit(1);
  return row;
}

export async function assertAgentVisibleToUser(tenantId: string, userId: string, agentId: string): Promise<AgentRow> {
  const row = await findVisibleAgent(tenantId, userId, agentId);
  if (!row) throw new NotFoundException(`Agent ${agentId} not found`);
  return row;
}

export function canEditAgent(agent: AgentRow, userId: string): boolean {
  return agent.origin === 'custom' && (agent.visibility === 'public' || agent.createdBy === userId);
}

export function liveBuiltInSlugs(): string[] {
  return Object.keys(readMergedAgentRegistry().agents).filter((slug) => slug !== BUILDER_AGENT_SLUG);
}

export function liveAgentsWhere(tenantId: string, userId: string | null): SQL | undefined {
  const slugs = liveBuiltInSlugs();
  const builtIn = and(eq(agents.origin, 'built_in'), slugs.length > 0 ? inArray(agents.name, slugs) : sql`false`);
  const custom = and(
    eq(agents.origin, 'custom'),
    sql`exists (
    select 1
    from ${agentSettings}
    inner join ${agentProfiles}
      on ${agentProfiles.agentId} = ${agentSettings.agentId}
     and ${agentProfiles.environmentId} = ${agentSettings.defaultEnvironmentId}
    where ${agentSettings.agentId} = ${agents.id}
  )`
  );
  return and(visibleAgentsWhere(tenantId, userId ?? ''), or(builtIn, custom));
}
