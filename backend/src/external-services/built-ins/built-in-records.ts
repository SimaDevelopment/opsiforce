import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { CallRow, CountEntry, ServiceRecords } from '@opsiforce/external-service-sdk/server';
import { db } from '../../../db';
import { externalServiceCalls, type ExternalServiceCallOutcomeValue } from '../../../db/schema';
import type { RegisteredService } from '../registry/service-registry';
import { builtInCount, ExternalServiceUsageService, ownerOfEnvironment } from '../usage/external-service-usage.service';
import type { UsageCount } from '../usage/external-service-usage.types';

function tableOutcome(outcome: CallRow['outcome']): ExternalServiceCallOutcomeValue {
  return outcome === 'proxied' ? 'handled' : outcome;
}

function builtInCountsOf(row: CallRow): UsageCount[] {
  if (row.callerKind !== 'call') return [];
  return [
    builtInCount('requests'),
    ...(row.outcome === 'not allowed' ? [builtInCount('not_allowed')] : []),
    ...(row.outcome === 'failed' ? [builtInCount('failed')] : []),
  ];
}

@Injectable()
export class BuiltInRecords {
  private readonly logger = new Logger(BuiltInRecords.name);
  constructor(private readonly usage: ExternalServiceUsageService) {}

  of(service: RegisteredService): ServiceRecords {
    return {
      call: (row) => void this.writeCall(service, row),
      count: (entry) => void this.writeCount(service, entry),
    };
  }

  private async writeCall(service: RegisteredService, row: CallRow): Promise<void> {
    try {
      const owner = row.projectEnvironmentId ? await ownerOfEnvironment(row.projectEnvironmentId) : null;
      await db.insert(externalServiceCalls).values({
        id: randomUUID(),
        requestId: row.requestId,
        externalServiceId: service.id,
        slug: service.slug,
        manifestHash: service.manifestHash,
        tenantId: owner?.tenantId ?? null,
        projectId: row.projectId ?? owner?.projectId ?? null,
        projectEnvironmentId: owner ? row.projectEnvironmentId : null,
        environment: row.environment,
        callerKind: row.callerKind,
        method: row.method,
        path: row.path,
        route: row.route,
        outcome: tableOutcome(row.outcome),
        reason: row.reason,
        status: row.status,
        inputBytes: row.bytesIn,
        outputBytes: row.bytesOut,
        durationMs: row.durationMs,
        notes: row.notes,
        createdAt: new Date(row.time),
      });
      if (owner && row.projectEnvironmentId) {
        await this.usage.count(
          { ...owner, projectEnvironmentId: row.projectEnvironmentId, service: service.slug },
          builtInCountsOf(row)
        );
      }
    } catch (error) {
      this.logger.warn(`Could not record a call of "${service.slug}" (${row.requestId}): ${(error as Error).message}`);
    }
  }

  private async writeCount(service: RegisteredService, entry: CountEntry): Promise<void> {
    if (!entry.projectEnvironmentId) return;
    try {
      const owner = await ownerOfEnvironment(entry.projectEnvironmentId);
      if (!owner) return;
      await this.usage.count(
        {
          tenantId: owner.tenantId,
          projectId: entry.projectId ?? owner.projectId,
          projectEnvironmentId: entry.projectEnvironmentId,
          service: service.slug,
        },
        [{ name: entry.name, label: entry.label, n: entry.n }]
      );
    } catch (error) {
      this.logger.warn(`Could not count ${entry.name} for "${service.slug}": ${(error as Error).message}`);
    }
  }
}
