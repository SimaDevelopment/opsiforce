import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { ProjectService } from './project.service';
import { ProjectImportService } from './project-import.service';
import { PROJECT_IMPORT_QUEUE, ProjectImportJobData, ProjectImportStatus } from './project-import.types';

@Processor(PROJECT_IMPORT_QUEUE)
export class ProjectImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ProjectImportProcessor.name);
  private readonly storageMountPath: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly importService: ProjectImportService
  ) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
  }

  async process(job: Job<ProjectImportJobData>): Promise<void> {
    const started = Date.now();
    const { importJobId, projectId, archivePath } = job.data;

    const existing = await this.importService.getJob(importJobId).catch(() => null);
    if (!existing || existing.status !== ProjectImportStatus.Queued) {
      this.logger.warn(`Skipping import ${importJobId}: already ${existing?.status ?? 'missing'}`);
      return;
    }

    try {
      const project = await this.projectService.findOneById(projectId);
      const projectDir = path.join(this.storageMountPath, project.directory);

      await this.importService.setStatus(importJobId, projectId, ProjectImportStatus.Unpacking);
      await this.importService.unpack(archivePath, projectDir, (bytesProcessed, bytesTotal) =>
        this.importService.updateProgress(importJobId, projectId, { bytesProcessed, bytesTotal })
      );

      await this.importService.setStatus(importJobId, projectId, ProjectImportStatus.Starting);
      await this.projectService.requestStartupForId(projectId);

      await rm(archivePath, { force: true }).catch(() => {});
      this.logger.log(`Unpacked import ${importJobId} into project ${projectId} in ${Date.now() - started}ms`);
    } catch (err) {
      await rm(archivePath, { force: true }).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      await this.importService.markFailed(importJobId, projectId, userFacingImportError(message));
      await this.projectService.discardHalfCreatedProject(projectId);
      this.logger.warn(`Failed to import project ${projectId}: ${message}`);
    }
  }
}

function userFacingImportError(message: string): string {
  if (/unsafe|not a valid project export|malformed/i.test(message)) {
    return 'The uploaded file is not a valid project export.';
  }
  return 'Import failed unexpectedly. Please try again.';
}
