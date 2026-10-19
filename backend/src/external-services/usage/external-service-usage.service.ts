import { Injectable } from '@nestjs/common';
import { builtInCounters, type BuiltInCounterName } from '@opsiforce/external-service-sdk/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceUsage, projectEnvironments, projects } from '../../../db/schema';
import type { DbExecutor } from '../../common/locks';
import type { UsageBucketKey, UsageCount } from './external-service-usage.types';

export function builtInCount(name: BuiltInCounterName, n = 1): UsageCount {
  return { name, label: builtInCounters[name].label, n };
}

export interface EnvironmentOwner {
  tenantId: string;
  projectId: string;
}

export async function ownerOfEnvironment(projectEnvironmentId: string): Promise<EnvironmentOwner | null> {
  const [owner] = await db
    .select({ tenantId: projects.tenantId, projectId: projects.id })
    .from(projectEnvironments)
    .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
    .where(eq(projectEnvironments.id, projectEnvironmentId));
  return owner?.tenantId ? { tenantId: owner.tenantId, projectId: owner.projectId } : null;
}

@Injectable()
export class ExternalServiceUsageService {
  async count(key: UsageBucketKey, counts: readonly UsageCount[], executor: DbExecutor = db): Promise<void> {
    for (const { name, label, n } of counts) {
      if (n < 1) continue;
      await executor
        .insert(externalServiceUsage)
        .values({
          id: crypto.randomUUID(),
          tenantId: key.tenantId,
          projectId: key.projectId,
          projectEnvironmentId: key.projectEnvironmentId,
          service: key.service,
          month: currentMonthStart(),
          name,
          label,
          value: n,
        })
        .onConflictDoUpdate({
          target: [
            externalServiceUsage.tenantId,
            externalServiceUsage.service,
            externalServiceUsage.month,
            externalServiceUsage.projectId,
            externalServiceUsage.projectEnvironmentId,
            externalServiceUsage.name,
          ],
          set: {
            value: sql`${externalServiceUsage.value} + ${n}`,
            label,
            updatedAt: new Date(),
          },
        });
    }
  }
}

function currentMonthStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}
