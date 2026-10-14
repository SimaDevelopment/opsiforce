import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { access } from 'fs/promises';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import type { Database } from 'sqlite';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import {
  environmentDatabasePath,
  openEnvironmentDatabase,
  type SqlitePragmaProfile,
} from '../common/environment-database';

export const REQUEST_LOG_CLEANUP_QUEUE = 'request-log-cleanup';

export const REQUEST_LOG_CLEANUP_BATCH_SIZE = 1000;

const REQUEST_LOG_CLEANUP_BATCH_PAUSE_MS = 25;
const REQUEST_LOG_DATABASE_FILE = 'database.db';
const REQUEST_LOG_PRAGMAS: SqlitePragmaProfile = { busyTimeoutMs: 5000 };

interface DeletedRows {
  deleted: number;
  batches: number;
}

@Processor(REQUEST_LOG_CLEANUP_QUEUE)
export class RequestLogCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(RequestLogCleanupProcessor.name);
  private readonly storageMountPath: string;
  private readonly retentionDays: number;

  constructor(private readonly configService: ConfigService) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.retentionDays = this.configService.getOrThrow<number>('requestLogRetentionDays');
  }

  async process(_job: Job): Promise<void> {
    const startedAt = Date.now();
    const rows = await db
      .select({ id: projectEnvironments.id, directory: projectEnvironments.directory })
      .from(projectEnvironments);

    let scanned = 0;
    let skipped = 0;
    let totalDeleted = 0;
    let totalBatches = 0;

    for (const row of rows) {
      const envDirectory = path.join(this.storageMountPath, row.directory);
      const dbPath = environmentDatabasePath(envDirectory, REQUEST_LOG_DATABASE_FILE);

      const exists = await access(dbPath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        skipped++;
        continue;
      }

      try {
        const { deleted, batches } = await this.cleanupDatabase(envDirectory);
        totalDeleted += deleted;
        totalBatches += batches;
        scanned++;
      } catch (err) {
        this.logger.warn(
          `Failed to clean request log for environment ${row.id} at ${dbPath}: ${(err as Error).message}`
        );
      }
    }

    this.logger.log(
      `Request log cleanup finished: scanned=${scanned} skipped=${skipped} deleted=${totalDeleted} batches=${totalBatches} retentionDays=${this.retentionDays} durationMs=${Date.now() - startedAt}`
    );
  }

  private async cleanupDatabase(envDirectory: string): Promise<DeletedRows> {
    const connection = await openEnvironmentDatabase(envDirectory, REQUEST_LOG_DATABASE_FILE, REQUEST_LOG_PRAGMAS);
    try {
      if (!(await hasRequestLog(connection))) return { deleted: 0, batches: 0 };
      return await this.deleteExpiredInBatches(connection);
    } finally {
      await connection.close().catch(() => {});
    }
  }

  private async deleteExpiredInBatches(connection: Database): Promise<DeletedRows> {
    const cutoff = `-${this.retentionDays} days`;
    let deleted = 0;
    let batches = 0;

    for (;;) {
      const result = await connection.run(
        `DELETE FROM app_requests WHERE id IN (
           SELECT id FROM app_requests WHERE created_at < datetime('now', ?) ORDER BY id LIMIT ?
         )`,
        cutoff,
        REQUEST_LOG_CLEANUP_BATCH_SIZE
      );
      const removed = result.changes ?? 0;
      deleted += removed;
      batches++;
      if (removed < REQUEST_LOG_CLEANUP_BATCH_SIZE) return { deleted, batches };
      await sleep(REQUEST_LOG_CLEANUP_BATCH_PAUSE_MS);
    }
  }
}

async function hasRequestLog(connection: Database): Promise<boolean> {
  const row = await connection.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'app_requests'"
  );
  return (row?.count ?? 0) > 0;
}
