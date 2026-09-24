import { NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfiles, agentSettings, agents, tenantDisabledAgents } from '../../db/schema';
import { readMergedAgentRegistry } from './agent-config';

export const BUILDER_AGENT_SLUG = 'skill-agent-builder';

export type AgentRow = typeof agents.$inferSelect & { disabled: boolean };

export function agentDisabledIn(tenantId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${tenantDisabledAgents}
    where ${tenantDisabledAgents.agentId} = ${agents.id} and ${tenantDisabledAgents.tenantId} = ${tenantId}
  )`;
}

export function agentColumnsIn(tenantId: string) {
  return { ...getTableColumns(agents), disabled: agentDisabledIn(tenantId) };
}

export interface VisibilityOptions {
  includeDisabled?: boolean;
}

export function visibleAgentsWhere(tenantId: string, userId: string, options: VisibilityOptions = {}): SQL | undefined {
  const scoped = or(
    and(isNull(agents.tenantId), eq(agents.origin, 'built_in')),
    and(eq(agents.tenantId, tenantId), or(eq(agents.visibility, 'public'), eq(agents.createdBy, userId)))
  );
  return options.includeDisabled ? scoped : and(scoped, not(agentDisabledIn(tenantId)));
}

export async function findVisibleAgent(
  tenantId: string,
  userId: string,
  agentId: string
): Promise<AgentRow | undefined> {
  const [row] = await db
    .select(agentColumnsIn(tenantId))
    .from(agents)
    .where(and(eq(agents.id, agentId), visibleAgentsWhere(tenantId, userId, { includeDisabled: true })))
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

export function startableBuiltInAgentsWhere(tenantId: string): SQL | undefined {
  const slugs = liveBuiltInSlugs();
  return and(
    eq(agents.origin, 'built_in'),
    isNull(agents.tenantId),
    slugs.length > 0 ? inArray(agents.name, slugs) : sql`false`,
    not(agentDisabledIn(tenantId))
  );
}

export function canDisableAgent(agent: AgentRow, userId: string): boolean {
  return agent.origin === 'custom' ? canEditAgent(agent, userId) : agent.name !== BUILDER_AGENT_SLUG;
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
