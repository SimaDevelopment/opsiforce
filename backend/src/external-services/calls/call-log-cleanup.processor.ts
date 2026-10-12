import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { inArray, lt } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceCalls } from '../../../db/schema';

export const EXTERNAL_SERVICE_CALL_LOG_CLEANUP_QUEUE = 'external-service-call-log-cleanup';

export const CALL_LOG_CLEANUP_BATCH_SIZE = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

@Processor(EXTERNAL_SERVICE_CALL_LOG_CLEANUP_QUEUE)
export class CallLogCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(CallLogCleanupProcessor.name);
  private readonly retentionDays: number;

  constructor(configService: ConfigService) {
    super();
    this.retentionDays = configService.getOrThrow<number>('externalServiceCallLogRetentionDays');
  }

  async process(_job: Job): Promise<void> {
    const startedAt = Date.now();
    const cutoff = new Date(startedAt - this.retentionDays * DAY_MS);
    let deleted = 0;
    let batches = 0;

    for (;;) {
      const expired = db
        .select({ id: externalServiceCalls.id })
        .from(externalServiceCalls)
        .where(lt(externalServiceCalls.createdAt, cutoff))
        .limit(CALL_LOG_CLEANUP_BATCH_SIZE);
      const removed = (
        await db
          .delete(externalServiceCalls)
          .where(inArray(externalServiceCalls.id, expired))
          .returning({ id: externalServiceCalls.id })
      ).length;
      deleted += removed;
      batches++;
      if (removed < CALL_LOG_CLEANUP_BATCH_SIZE) break;
    }

    this.logger.log(
      `External Service Call log cleanup finished: deleted=${deleted} batches=${batches} retentionDays=${this.retentionDays} durationMs=${Date.now() - startedAt}`
    );
  }
}
