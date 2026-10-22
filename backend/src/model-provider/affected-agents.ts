import { ConflictException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, like, not, sql } from 'drizzle-orm';
import { agentProfiles, agents } from '../../db/schema';
import { readMergedAgentRegistry } from '../agent/agent-config';
import { baseFormatOfModel } from '../agent/agent-models';
import { agentDisabledIn } from '../agent/agent-visibility';
import type { DbExecutor } from '../common/locks';
import { BASE_FORMATS, type BaseFormatId } from './base-formats';

export interface AffectedAgent {
  id: string;
  name: string;
  origin: 'custom' | 'built_in';
}

export async function agentsUsingFormat(
  executor: DbExecutor,
  tenantId: string,
  format: BaseFormatId
): Promise<AffectedAgent[]> {
  const [custom, builtIn] = await Promise.all([
    customAgentsUsing(executor, tenantId, format),
    builtInAgentsUsing(executor, tenantId, format),
  ]);
  return [...custom, ...builtIn];
}

async function customAgentsUsing(
  executor: DbExecutor,
  tenantId: string,
  format: BaseFormatId
): Promise<AffectedAgent[]> {
  const name = sql<string>`coalesce(${agents.displayName}, ${agents.name})`;
  const rows = await executor
    .selectDistinct({ id: agents.id, name })
    .from(agents)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
    .where(
      and(
        eq(agents.tenantId, tenantId),
        eq(agents.origin, 'custom'),
        like(agentProfiles.model, `${BASE_FORMATS[format].modelCatalogKey}/%`)
      )
    )
    .orderBy(asc(name));
  return rows.map((row) => ({ id: row.id, name: row.name, origin: 'custom' }));
}

async function builtInAgentsUsing(
  executor: DbExecutor,
  tenantId: string,
  format: BaseFormatId
): Promise<AffectedAgent[]> {
  const registry = readMergedAgentRegistry().agents;
  const slugs = Object.keys(registry).filter((slug) => baseFormatOfModel(registry[slug]?.model ?? '') === format);
  if (slugs.length === 0) return [];
  const rows = await executor
    .select({ id: agents.id, slug: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(
      and(
        isNull(agents.tenantId),
        eq(agents.origin, 'built_in'),
        inArray(agents.name, slugs),
        not(agentDisabledIn(tenantId))
      )
    )
    .orderBy(asc(agents.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? registry[row.slug]?.name ?? row.slug,
    origin: 'built_in',
  }));
}

export function agentsAffected(format: BaseFormatId, affected: AffectedAgent[]): ConflictException {
  return new ConflictException({
    code: 'agents_affected',
    message: `No ${format} model provider would be on, so these Agents' ${format} models would stop working`,
    format,
    agents: affected,
  });
}
