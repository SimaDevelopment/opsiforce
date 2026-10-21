import { BadRequestException } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agentPodSettings, agentSettings } from '../../db/schema';
import type { DbExecutor } from '../common/locks';
import { assertWithinLimit } from '../limit/limits';
import { isDefaultPodSettings, resolvePodSettings, type PodSettings } from '../pod/pod-classes';
import { podSettingsColumns } from '../pod/pod-settings-columns';

export const MAX_WARM_POOL_SIZE = 3;

export async function readAgentPodSettings(agentId: string, executor: DbExecutor = db): Promise<PodSettings> {
  const [row] = await executor
    .select(podSettingsColumns(agentPodSettings))
    .from(agentPodSettings)
    .where(eq(agentPodSettings.agentId, agentId))
    .limit(1);
  return resolvePodSettings(row);
}

export async function readAgentPodSettingsFor(agentIds: string[]): Promise<Map<string, PodSettings>> {
  if (agentIds.length === 0) return new Map();
  const rows = await db
    .select({ agentId: agentPodSettings.agentId, ...podSettingsColumns(agentPodSettings) })
    .from(agentPodSettings)
    .where(inArray(agentPodSettings.agentId, agentIds));
  return new Map(rows.map(({ agentId, ...settings }) => [agentId, resolvePodSettings(settings)]));
}

export async function writeAgentPodSettings(
  executor: DbExecutor,
  agentId: string,
  settings: PodSettings
): Promise<void> {
  if (isDefaultPodSettings(settings)) {
    await executor.delete(agentPodSettings).where(eq(agentPodSettings.agentId, agentId));
    return;
  }
  await executor
    .insert(agentPodSettings)
    .values({ agentId, ...settings })
    .onConflictDoUpdate({ target: agentPodSettings.agentId, set: settings });
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
