import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { chmod, copyFile, mkdir, readlink, rm, rename, symlink } from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectDuplicateJobs } from '../../db/schema';
import { DeliveryService } from '../delivery/delivery.service';
import { GitService } from '../git/git.service';
import { ProjectService } from './project.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectFilesService, type ProjectFileEntry } from './project-files.service';
import {
  PROJECT_DUPLICATE_QUEUE,
  ProjectDuplicateStatus,
  type ProjectDuplicateJobData,
} from './project-duplicate.types';

interface CopyProgress {
  bytesCopied: number;
}

@Processor(PROJECT_DUPLICATE_QUEUE)
export class ProjectDuplicateProcessor extends WorkerHost {
  private readonly logger = new Logger(ProjectDuplicateProcessor.name);
  private readonly storageMountPath: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly gitService: GitService,
    private readonly projectFilesService: ProjectFilesService,
    private readonly delivery: DeliveryService
  ) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
  }

  async process(job: Job<ProjectDuplicateJobData>): Promise<void> {
    const started = Date.now();
    const { duplicateJobId, sourceProjectId, targetProjectId } = job.data;
    let tempPath: string | undefined;

    try {
      const source = await this.projectService.findOneById(sourceProjectId);
      const target = await this.projectService.findOneById(targetProjectId);
      const sourcePath = path.join(this.storageMountPath, source.directory);
      const targetPath = path.join(this.storageMountPath, target.directory);
      tempPath = path.join(path.dirname(targetPath), `.${target.id}.copying`);

      await this.markStatus(duplicateJobId, targetProjectId, ProjectDuplicateStatus.Committing, { start: true });
      await this.gitService.commitWorkingTree(sourcePath, `Duplicate to ${targetProjectId}`);

      await this.markStatus(duplicateJobId, targetProjectId, ProjectDuplicateStatus.Cloning);
      await rm(tempPath, { recursive: true, force: true });
      await mkdir(path.dirname(tempPath), { recursive: true });
      await this.gitService.cloneLocal(sourcePath, tempPath);
      await this.gitService.removeOrigin(tempPath);

      await this.markStatus(duplicateJobId, targetProjectId, ProjectDuplicateStatus.Copying);
      const entries = await this.projectFilesService.collectRuntimeEntries(sourcePath);
      const bytesTotal = entries.reduce((total, entry) => total + entry.size, 0);

      await this.updateProgress(duplicateJobId, targetProjectId, { bytesTotal, bytesCopied: 0 });

      const progress = { bytesCopied: 0 };
      let lastPersistedAt = 0;

      const persistProgress = async (force = false) => {
        const now = Date.now();
        if (!force && now - lastPersistedAt < 1000) return;
        lastPersistedAt = now;
        await this.updateProgress(duplicateJobId, targetProjectId, progress);
      };

      for (const entry of entries) {
        await this.copyEntry(entry, tempPath, progress);
        await persistProgress();
      }

      await persistProgress(true);
      await rm(targetPath, { recursive: true, force: true });
      await rename(tempPath, targetPath);
      await this.delivery.copyLedger(sourceProjectId, targetProjectId);
      await this.markStarting(duplicateJobId, targetProjectId);
      await this.projectService.requestStartupForId(targetProjectId);
      this.logger.log(`Duplicated project ${sourceProjectId} to ${targetProjectId} in ${Date.now() - started}ms`);
    } catch (err) {
      if (tempPath) await rm(tempPath, { recursive: true, force: true }).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(duplicateJobId, targetProjectId, message);
      this.logger.warn(`Failed to duplicate project ${sourceProjectId} to ${targetProjectId}: ${message}`);
      throw err;
    }
  }

  private async copyEntry(entry: ProjectFileEntry, targetRoot: string, progress: CopyProgress): Promise<void> {
    const target = path.join(targetRoot, entry.relPath);

    if (entry.type === 'directory') {
      await mkdir(target, { recursive: true });
      await chmod(target, entry.mode);
      return;
    }

    await mkdir(path.dirname(target), { recursive: true });

    if (entry.type === 'symlink') {
      const link = await readlink(entry.source);
      await symlink(link, target);
      return;
    }

    await copyFile(entry.source, target);
    await chmod(target, entry.mode);
    progress.bytesCopied += entry.size;
  }

  private async markStatus(
    id: string,
    targetProjectId: string,
    status: ProjectDuplicateStatus,
    options: { start?: boolean } = {}
  ): Promise<void> {
    await db
      .update(projectDuplicateJobs)
      .set({
        status,
        updatedAt: new Date(),
        ...(options.start
          ? { startedAt: new Date(), completedAt: null, error: null, bytesTotal: 0, bytesCopied: 0 }
          : {}),
      })
      .where(eq(projectDuplicateJobs.id, id));
    await this.projectEventsService.publish(targetProjectId);
  }

  private async markStarting(id: string, targetProjectId: string): Promise<void> {
    await db
      .update(projectDuplicateJobs)
      .set({
        status: ProjectDuplicateStatus.Starting,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectDuplicateJobs.id, id));
    await this.projectEventsService.publish(targetProjectId);
  }

  private async markFailed(id: string, targetProjectId: string, error: string): Promise<void> {
    await db
      .update(projectDuplicateJobs)
      .set({
        status: ProjectDuplicateStatus.Failed,
        error,
        updatedAt: new Date(),
      })
      .where(eq(projectDuplicateJobs.id, id));
    await this.projectEventsService.publish(targetProjectId);
  }

  private async updateProgress(
    id: string,
    targetProjectId: string,
    progress: Partial<CopyProgress> & Partial<{ bytesTotal: number }>
  ): Promise<void> {
    await db
      .update(projectDuplicateJobs)
      .set({
        ...progress,
        updatedAt: new Date(),
      })
      .where(eq(projectDuplicateJobs.id, id));
    await this.projectEventsService.publish(targetProjectId);
  }
}
