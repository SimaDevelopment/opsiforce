import { and, eq } from 'drizzle-orm';
import { globalLimits, tenantLimits } from '../../db/schema';
import { lockTenantLimit, type DbExecutor } from '../common/locks';
import { LimitReachedException } from './limit-reached.exception';
import { LIMIT_KEYS, LIMITS } from './limit-registry';
import type { LimitKey, LimitUsage } from './limit.types';

export async function resolveLimit(executor: DbExecutor, tenantId: string, key: LimitKey): Promise<number | null> {
  const [override] = await executor
    .select({ value: tenantLimits.value })
    .from(tenantLimits)
    .where(and(eq(tenantLimits.tenantId, tenantId), eq(tenantLimits.limitKey, key)));
  if (override) return override.value;
  const [platform] = await executor
    .select({ value: globalLimits.value })
    .from(globalLimits)
    .where(eq(globalLimits.limitKey, key));
  return platform?.value ?? null;
}

export async function assertWithinLimit(executor: DbExecutor, tenantId: string, key: LimitKey): Promise<void> {
  await lockTenantLimit(executor, tenantId, key);
  const limit = await resolveLimit(executor, tenantId, key);
  if (limit === null) return;
  if ((await LIMITS[key].count(executor, tenantId)) >= limit) throw new LimitReachedException(key, limit);
}

export async function limitUsage(executor: DbExecutor, tenantId: string): Promise<LimitUsage[]> {
  return Promise.all(
    LIMIT_KEYS.map(async (key) => ({
      key,
      limit: await resolveLimit(executor, tenantId, key),
      used: await LIMITS[key].count(executor, tenantId),
    }))
  );
}
