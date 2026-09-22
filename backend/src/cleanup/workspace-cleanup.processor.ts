import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { and, eq, lte, type SQL } from 'drizzle-orm';
import { readdir, rm, rmdir, stat } from 'fs/promises';
import path from 'path';
import { db } from '../../db';
import { deletedProjectEnvironments, projectEnvironments } from '../../db/schema';

export const WORKSPACE_CLEANUP_QUEUE = 'workspace-cleanup';

export interface WorkspaceCleanupJobData {
  tenantId?: string;
  ignoreRetention?: boolean;
}

@Processor(WORKSPACE_CLEANUP_QUEUE)
export class WorkspaceCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkspaceCleanupProcessor.name);
  private readonly storageMountPath: string;
  private readonly retentionDays: number;

  constructor(private readonly configService: ConfigService) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.retentionDays = this.configService.getOrThrow<number>('workspaceCleanupRetentionDays');
  }

  async process(job: Job<WorkspaceCleanupJobData | undefined>): Promise<void> {
    const scope = job.data ?? {};
    await this.removeExpiredTombstones(scope);
    if (!scope.tenantId) await this.removeOrphanedDirectories();
  }

  private async removeExpiredTombstones(scope: WorkspaceCleanupJobData): Promise<void> {
    const cutoff = scope.ignoreRetention ? new Date() : new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    const conditions: SQL[] = [lte(deletedProjectEnvironments.deletedAt, cutoff)];
    if (scope.tenantId) conditions.push(eq(deletedProjectEnvironments.tenantId, scope.tenantId));
    const expiredEnvironments = await db
      .select({ id: deletedProjectEnvironments.id, directory: deletedProjectEnvironments.directory })
      .from(deletedProjectEnvironments)
      .where(and(...conditions));

    if (expiredEnvironments.length === 0) return;
    this.logger.log(`Found ${expiredEnvironments.length} expired workspace(s) to clean up`);

    let removed = 0;

    for (const record of expiredEnvironments) {
      if (!(await this.tryRemoveTombstoneDirectory(record.directory))) continue;
      await db.delete(deletedProjectEnvironments).where(eq(deletedProjectEnvironments.id, record.id));
      removed++;
    }

    this.logger.log(`Removed ${removed} of ${expiredEnvironments.length} expired workspace(s)`);
  }

  private async tryRemoveTombstoneDirectory(directory: string): Promise<boolean> {
    const workspacePath = path.join(this.storageMountPath, directory);
    try {
      await rm(workspacePath, { recursive: true, force: true });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to remove workspace ${directory}: ${(err as Error).message}`);
      return false;
    }
  }

  private async removeOrphanedDirectories(): Promise<void> {
    const [environmentRows, deletedEnvironmentRows] = await Promise.all([
      db.select({ directory: projectEnvironments.directory }).from(projectEnvironments),
      db.select({ directory: deletedProjectEnvironments.directory }).from(deletedProjectEnvironments),
    ]);

    const knownPaths = new Set<string>();
    for (const row of environmentRows) knownPaths.add(row.directory);
    for (const row of deletedEnvironmentRows) knownPaths.add(row.directory);

    const keepPrefixes = new Set<string>();
    for (const p of knownPaths) {
      let prefix: string | null = path.dirname(p);
      while (prefix && prefix !== '.' && prefix !== path.sep) {
        keepPrefixes.add(prefix);
        const parent = path.dirname(prefix);
        prefix = parent === prefix ? null : parent;
      }
    }

    const projectsRoot = path.join(this.storageMountPath, 'projects');
    const removed = await this.walk(projectsRoot, 'projects', knownPaths, keepPrefixes);
    if (removed > 0) this.logger.log(`Removed ${removed} orphaned workspace(s)`);
  }

  private async walk(
    absPath: string,
    relPath: string,
    knownPaths: Set<string>,
    keepPrefixes: Set<string>
  ): Promise<number> {
    const entries = await readdir(absPath, { withFileTypes: true }).catch(() => []);
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childAbs = path.join(absPath, entry.name);
      const childRel = path.posix.join(relPath, entry.name);

      if (entry.name.startsWith('.')) {
        if (await this.removeIfStaleTempDirectory(childAbs, childRel)) removed++;
        continue;
      }

      if (knownPaths.has(childRel)) continue;

      if (keepPrefixes.has(childRel)) {
        removed += await this.walk(childAbs, childRel, knownPaths, keepPrefixes);
        await this.removeIfEmpty(childAbs);
        continue;
      }

      await rm(childAbs, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(`Failed to remove orphaned workspace ${childRel}: ${(err as Error).message}`);
      });
      removed++;
    }

    return removed;
  }

  private async removeIfStaleTempDirectory(absPath: string, relPath: string): Promise<boolean> {
    const stats = await stat(absPath).catch(() => null);
    if (!stats) return false;
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs < this.retentionDays * 24 * 60 * 60 * 1000) return false;
    try {
      await rm(absPath, { recursive: true, force: true });
      this.logger.log(`Removed stale temp directory ${relPath}`);
      return true;
    } catch (err) {
      this.logger.warn(`Failed to remove stale temp directory ${relPath}: ${(err as Error).message}`);
      return false;
    }
  }

  private async removeIfEmpty(dirPath: string): Promise<boolean> {
    const entries = await readdir(dirPath).catch(() => null);
    if (!entries || entries.length > 0) return false;
    return rmdir(dirPath)
      .then(() => true)
      .catch(() => false);
  }
}
