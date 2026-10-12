import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceCalls, type JsonValue } from '../../../db/schema';
import { ExternalServiceUsageService } from '../usage/external-service-usage.service';

export type CallRecord = typeof externalServiceCalls.$inferInsert;

export interface ListedCall {
  callId: string;
  kind: string;
  via: string | null;
  operation: string | null;
  operationKind: string | null;
  decision: string;
  status: number;
  code: string | null;
  detail: string | null;
  bounds: JsonValue | null;
  inputBytes: number | null;
  outputBytes: number | null;
  durationMs: number;
  manifestHash: string | null;
  createdAt: Date;
}

export interface RecentCallsQuery {
  projectEnvironmentId: string;
  externalServiceId: string;
  limit: number;
}

export const maxCallDetailLength = 500;

export function callDetail(detail: unknown): string | null {
  if (typeof detail !== 'string' || detail === '') return null;
  return detail.length > maxCallDetailLength ? `${detail.slice(0, maxCallDetailLength - 1)}…` : detail;
}

const CALL_SERVICE_FK = 'external_service_calls_external_service_id_external_services_id';

function referencesDeletedService(error: unknown): boolean {
  const direct = error as { code?: string; constraint_name?: string; cause?: unknown };
  const pg = direct?.code ? direct : ((direct?.cause as typeof direct | undefined) ?? {});
  return pg.code === '23503' && pg.constraint_name === CALL_SERVICE_FK;
}

@Injectable()
export class CallLog {
  private readonly logger = new Logger(CallLog.name);

  constructor(private readonly usage: ExternalServiceUsageService) {}

  async record(call: CallRecord): Promise<void> {
    try {
      await this.insert(call);
    } catch (error) {
      if (call.externalServiceId && referencesDeletedService(error)) {
        await this.record({ ...call, externalServiceId: null });
        return;
      }
      this.logger.warn(
        `Could not log External Service call ${call.id} (${call.slug} ${call.operation ?? ''}): ${(error as Error).message}`
      );
    }
  }

  private insert(call: CallRecord): Promise<void> {
    return db.transaction(async (tx) => {
      await tx.insert(externalServiceCalls).values({ ...call, detail: callDetail(call.detail) });
      await this.usage.countCall(call, tx);
    });
  }

  recentFor(query: RecentCallsQuery): Promise<ListedCall[]> {
    return db
      .select({
        callId: externalServiceCalls.id,
        kind: externalServiceCalls.kind,
        via: externalServiceCalls.via,
        operation: externalServiceCalls.operation,
        operationKind: externalServiceCalls.operationKind,
        decision: externalServiceCalls.decision,
        status: externalServiceCalls.status,
        code: externalServiceCalls.code,
        detail: externalServiceCalls.detail,
        bounds: externalServiceCalls.bounds,
        inputBytes: externalServiceCalls.inputBytes,
        outputBytes: externalServiceCalls.outputBytes,
        durationMs: externalServiceCalls.durationMs,
        manifestHash: externalServiceCalls.manifestHash,
        createdAt: externalServiceCalls.createdAt,
      })
      .from(externalServiceCalls)
      .where(
        and(
          eq(externalServiceCalls.projectEnvironmentId, query.projectEnvironmentId),
          eq(externalServiceCalls.externalServiceId, query.externalServiceId)
        )
      )
      .orderBy(desc(externalServiceCalls.createdAt), desc(externalServiceCalls.id))
      .limit(query.limit);
  }
}
