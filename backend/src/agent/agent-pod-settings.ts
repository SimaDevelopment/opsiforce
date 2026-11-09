import { BadRequestException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { agentPodSettings, agentSettings, agents, tenantAgentPodSettings } from '../../db/schema';
import { lockTenantLimit, type DbExecutor } from '../common/locks';
import { assertWithinLimit } from '../limit/limits';
import type { PodSettings } from '../pod/pod-classes';
import { podSettingsColumns, storedLegacyPodSettings, storedPodSettings } from '../pod/pod-settings-columns';
import { podSettingsOn, readPresetCatalog, type PresetCatalog } from '../pod/resource-presets';
import type { AgentProjectSettings } from './agent-copy-settings';
import { carriedInactivityCleanup } from '../project/inactivity-cleanup';

export const MAX_WARM_POOL_SIZE = 3;

/** Where an Agent's Resources come from for one Organization: its own choice there, a Built-in Agent's platform choice, or the default preset. */
export type AgentResourcesSource = 'own' | 'platform' | 'default';

export interface AgentResources {
  resources: PodSettings;
  source: AgentResourcesSource;
  inherited: PodSettings;
  /** A Built-in Agent's platform choice, a preset or Custom numbers; null when it follows the default preset. */
  platformChoice: PodSettings | null;
}

export async function readAgentResources(
  agentId: string,
  tenantId: string | null,
  executor: DbExecutor = db,
  catalog?: PresetCatalog
): Promise<AgentResources> {
  const presets = catalog ?? (await readPresetCatalog(tenantId, executor));
  const [agent] = await executor.select({ origin: agents.origin }).from(agents).where(eq(agents.id, agentId)).limit(1);
  const builtIn = agent?.origin === 'built_in';

  const [row] = await executor
    .select(podSettingsColumns(agentPodSettings))
    .from(agentPodSettings)
    .where(eq(agentPodSettings.agentId, agentId))
    .limit(1);
  const fallback = podSettingsOn(undefined, presets);

  if (builtIn && tenantId) {
    const [own] = await executor
      .select(podSettingsColumns(tenantAgentPodSettings))
      .from(tenantAgentPodSettings)
      .where(and(eq(tenantAgentPodSettings.tenantId, tenantId), eq(tenantAgentPodSettings.agentId, agentId)))
      .limit(1);
    const inherited = row ? podSettingsOn(row, presets) : fallback;
    const platformChoice = row ? inherited : null;
    if (own) return { resources: podSettingsOn(own, presets), source: 'own', inherited, platformChoice };
    return { resources: inherited, source: row ? 'platform' : 'default', inherited, platformChoice };
  }
  const platformChoice = builtIn && row ? podSettingsOn(row, presets) : null;
  if (row) return { resources: podSettingsOn(row, presets), source: 'own', inherited: fallback, platformChoice };
  return { resources: fallback, source: 'default', inherited: fallback, platformChoice };
}

export async function readAgentPodSettings(
  agentId: string,
  tenantId: string | null,
  executor: DbExecutor = db
): Promise<PodSettings> {
  return (await readAgentResources(agentId, tenantId, executor)).resources;
}

/** Each Agent's Resources for its own Organization, or the platform's for a Built-in Agent, in the order given. */
export async function readAgentPodSettingsFor(
  agentRows: { id: string; tenantId: string | null }[]
): Promise<PodSettings[]> {
  const catalogs = new Map<string | null, PresetCatalog>();
  const settings: PodSettings[] = [];
  for (const agent of agentRows) {
    let catalog = catalogs.get(agent.tenantId);
    if (!catalog) {
      catalog = await readPresetCatalog(agent.tenantId);
      catalogs.set(agent.tenantId, catalog);
    }
    settings.push((await readAgentResources(agent.id, agent.tenantId, db, catalog)).resources);
  }
  return settings;
}

/** The Agent's own choice, or a Built-in Agent's platform choice; null returns it to the default preset. */
export async function writeAgentPodSettings(
  executor: DbExecutor,
  agentId: string,
  settings: PodSettings | null
): Promise<void> {
  if (!settings) {
    await executor.delete(agentPodSettings).where(eq(agentPodSettings.agentId, agentId));
    return;
  }
  const values = storedLegacyPodSettings(settings);
  await executor
    .insert(agentPodSettings)
    .values({ agentId, ...values })
    .onConflictDoUpdate({ target: agentPodSettings.agentId, set: values });
}

/** A Built-in Agent's choice in one Organization; null returns it to the platform's. */
export async function writeTenantAgentPodSettings(
  executor: DbExecutor,
  tenantId: string,
  agentId: string,
  settings: PodSettings | null
): Promise<void> {
  const target = and(eq(tenantAgentPodSettings.tenantId, tenantId), eq(tenantAgentPodSettings.agentId, agentId));
  if (!settings) {
    await executor.delete(tenantAgentPodSettings).where(target);
    return;
  }
  const values = storedPodSettings(settings);
  await executor
    .insert(tenantAgentPodSettings)
    .values({ tenantId, agentId, ...values })
    .onConflictDoUpdate({
      target: [tenantAgentPodSettings.tenantId, tenantAgentPodSettings.agentId],
      set: { ...values, updatedAt: new Date() },
    });
}

export async function readAgentProjectSettings(
  agentId: string,
  tenantId: string | null
): Promise<AgentProjectSettings> {
  const { resources, source } = await readAgentResources(agentId, tenantId);
  return {
    resources,
    followsDefault: source === 'default',
    warmPoolSize: await readWarmPoolSize(agentId),
    inactivityCleanup: await carriedInactivityCleanup(agentId, tenantId),
  };
}

export async function readWarmPoolSize(agentId: string, executor: DbExecutor = db): Promise<number> {
  const [row] = await executor
    .select({ warmPoolSize: agentSettings.warmPoolSize })
    .from(agentSettings)
    .where(eq(agentSettings.agentId, agentId))
    .limit(1);
  return row?.warmPoolSize ?? 0;
}

export async function writeWarmPoolSize(
  executor: DbExecutor,
  tenantId: string,
  agentId: string,
  warmPoolSize: number
): Promise<void> {
  await lockTenantLimit(executor, tenantId, 'warm_pool');
  const current = await readWarmPoolSize(agentId, executor);
  await assertWithinLimit(executor, tenantId, 'warm_pool', warmPoolSize - current);
  await executor
    .insert(agentSettings)
    .values({ agentId, warmPoolSize })
    .onConflictDoUpdate({ target: agentSettings.agentId, set: { warmPoolSize, updatedAt: new Date() } });
}

export function validWarmPoolSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_WARM_POOL_SIZE) {
    throw new BadRequestException({
      code: 'bad_request',
      message: `warmPoolSize must be a whole number from 0 to ${MAX_WARM_POOL_SIZE}`,
    });
  }
  return size;
}
