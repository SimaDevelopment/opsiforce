import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { globalLimits, tenantLimits, tenants } from '../../db/schema';
import { isLimitKey, LIMIT_KEYS } from './limit-registry';
import { limitUsage } from './limits';
import type { LimitKey, LimitUsage, TenantLimits, PlatformLimit, PlatformLimitsView } from './limit.types';

@Injectable()
export class LimitService {
  usage(tenantId: string): Promise<LimitUsage[]> {
    return limitUsage(db, tenantId);
  }

  async platformView(): Promise<PlatformLimitsView> {
    const [platform, tenantLimitsList] = await Promise.all([this.platformLimits(), this.allTenantLimits()]);
    return { platform, tenants: tenantLimitsList };
  }

  async setPlatformLimit(rawKey: string, rawValue: unknown): Promise<PlatformLimitsView> {
    const key = assertLimitKey(rawKey);
    const value = assertLimitValue(rawValue);
    await db
      .insert(globalLimits)
      .values({ limitKey: key, value })
      .onConflictDoUpdate({ target: globalLimits.limitKey, set: { value, updatedAt: new Date() } });
    return this.platformView();
  }

  async setTenantLimit(tenantId: string, rawKey: string, rawValue: unknown): Promise<PlatformLimitsView> {
    const key = assertLimitKey(rawKey);
    const value = assertLimitValue(rawValue);
    await assertTenantExists(tenantId);
    await db
      .insert(tenantLimits)
      .values({ tenantId, limitKey: key, value })
      .onConflictDoUpdate({
        target: [tenantLimits.tenantId, tenantLimits.limitKey],
        set: { value, updatedAt: new Date() },
      });
    return this.platformView();
  }

  async followPlatformLimit(tenantId: string, rawKey: string): Promise<PlatformLimitsView> {
    const key = assertLimitKey(rawKey);
    await assertTenantExists(tenantId);
    await db.delete(tenantLimits).where(and(eq(tenantLimits.tenantId, tenantId), eq(tenantLimits.limitKey, key)));
    return this.platformView();
  }

  private async platformLimits(): Promise<PlatformLimit[]> {
    const rows = await db.select().from(globalLimits);
    const valueByKey = new Map(rows.map((row) => [row.limitKey, row.value]));
    return LIMIT_KEYS.map((key) => ({ key, value: valueByKey.get(key) ?? null }));
  }

  private async allTenantLimits(): Promise<TenantLimits[]> {
    const [tenantRows, overrides] = await Promise.all([
      db
        .select({ tenantId: tenants.id, displayName: tenants.displayName })
        .from(tenants)
        .orderBy(asc(tenants.displayName)),
      db.select({ tenantId: tenantLimits.tenantId, limitKey: tenantLimits.limitKey }).from(tenantLimits),
    ]);
    const overridden = new Set(overrides.map((row) => `${row.tenantId}:${row.limitKey}`));

    return Promise.all(
      tenantRows.map(async (tenant) => ({
        tenantId: tenant.tenantId,
        displayName: tenant.displayName,
        limits: (await limitUsage(db, tenant.tenantId)).map((usage) =>
          Object.assign(usage, { overridden: overridden.has(`${tenant.tenantId}:${usage.key}`) })
        ),
      }))
    );
  }
}

function assertLimitKey(key: string): LimitKey {
  if (!isLimitKey(key)) throw new NotFoundException(`Unknown limit ${key}`);
  return key;
}

function assertLimitValue(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException('value must be a non-negative integer or null');
  }
  return value;
}

async function assertTenantExists(tenantId: string): Promise<void> {
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new NotFoundException(`Organization ${tenantId} not found`);
}
