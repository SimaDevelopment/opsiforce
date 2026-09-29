import { NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { agentProfiles, agentSettings, agents, environments, tenantDisabledAgents } from '../../db/schema';
import { TEST_PROJECT_KIND, type ProjectKind } from '../project/project.types';
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

export function canDuplicateAgent(agent: AgentRow): boolean {
  return agent.origin === 'custom' || agent.name !== BUILDER_AGENT_SLUG;
}

export function canDisableAgent(agent: AgentRow, userId: string): boolean {
  return agent.origin === 'custom' ? canEditAgent(agent, userId) : agent.name !== BUILDER_AGENT_SLUG;
}

export function liveAgentsWhere(tenantId: string, userId: string | null): SQL | undefined {
  return startableAgentsWhere(tenantId, userId, customAgentHasDefaultProfile());
}

/** A Test Project runs on Development, so a Custom Agent needs only a Development Profile (ADR-0063). */
export function testableAgentsWhere(tenantId: string, userId: string | null): SQL | undefined {
  return startableAgentsWhere(tenantId, userId, customAgentHasDevelopmentProfile());
}

export function projectCreatableAgentsWhere(
  tenantId: string,
  userId: string | null,
  kind: ProjectKind | null
): SQL | undefined {
  return kind === TEST_PROJECT_KIND ? testableAgentsWhere(tenantId, userId) : liveAgentsWhere(tenantId, userId);
}

function startableAgentsWhere(tenantId: string, userId: string | null, customProfile: SQL): SQL | undefined {
  const slugs = liveBuiltInSlugs();
  const builtIn = and(eq(agents.origin, 'built_in'), slugs.length > 0 ? inArray(agents.name, slugs) : sql`false`);
  const custom = and(eq(agents.origin, 'custom'), customProfile);
  return and(visibleAgentsWhere(tenantId, userId ?? ''), or(builtIn, custom));
}

function customAgentHasDefaultProfile(): SQL {
  return sql`exists (
    select 1
    from ${agentSettings}
    inner join ${agentProfiles}
      on ${agentProfiles.agentId} = ${agentSettings.agentId}
     and ${agentProfiles.environmentId} = ${agentSettings.defaultEnvironmentId}
    where ${agentSettings.agentId} = ${agents.id}
  )`;
}

function customAgentHasDevelopmentProfile(): SQL {
  return sql`exists (
    select 1
    from ${agentProfiles}
    inner join ${environments}
      on ${environments.id} = ${agentProfiles.environmentId}
     and ${environments.isDefault}
    where ${agentProfiles.agentId} = ${agents.id}
  )`;
}
