import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projectTransferJobs } from '../../db/schema';
import { AgentService } from '../agent/agent.service';
import { runtimeAgentSlug } from '../delivery/runtime-agent-slug';
import { GitService } from '../git/git.service';
import { ProjectService } from '../project/project.service';
import { ProjectEventsService } from '../project/project-events.service';
import { ProjectFilesService, type ProjectFileEntry } from '../project/project-files.service';
import { ProjectExportService } from './project-export.service';
import {
  EXPORT_FORMAT_VERSION,
  PROJECT_EXPORT_QUEUE,
  ProjectExportJobData,
  ProjectExportStatus,
  type ExportManifest,
  type ExportManifestAgent,
} from './project-export.types';

interface ArchiveEntry {
  source: string;
  relPath: string;
  type: 'file' | 'symlink';
  mode: number;
  size: number;
}

@Processor(PROJECT_EXPORT_QUEUE)
export class ProjectExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ProjectExportProcessor.name);
  private readonly storageMountPath: string;
  private readonly platformVersion: string;
  private readonly agentImageVersion: string;
  private readonly arch: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly projectFilesService: ProjectFilesService,
    private readonly gitService: GitService,
    private readonly agentService: AgentService,
    private readonly exportService: ProjectExportService
  ) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.platformVersion = this.configService.get<string>('platformVersion', '0.1.0');
    this.agentImageVersion = this.configService.get<string>('agentImageVersion', this.platformVersion);
    this.arch = this.configService.get<string>('arch', process.arch);
  }

  async process(job: Job<ProjectExportJobData>): Promise<void> {
    const started = Date.now();
    const { exportJobId, projectId } = job.data;
    const stagingRoot = this.exportService.stagingPath(exportJobId);
    const artifactPath = this.exportService.artifactPath(exportJobId);

    const existing = await this.exportService.getJob(exportJobId).catch(() => null);
    if (
      !existing ||
      existing.status === ProjectExportStatus.Completed ||
      existing.status === ProjectExportStatus.Failed
    ) {
      this.logger.warn(`Skipping export ${exportJobId}: already ${existing?.status ?? 'missing'}`);
      return;
    }

    try {
      const project = await this.projectService.findOneById(projectId);
      const identity = await this.agentService.resolveIdentity(project.agentId).catch(() => null);
      const agent: ExportManifestAgent | null = identity
        ? {
            slug: runtimeAgentSlug({ importedAgent: project.importedAgent, agentName: identity.name }),
            displayName: identity.displayName,
            origin: identity.origin,
            package: identity.package,
          }
        : null;
      const sourcePath = path.join(this.storageMountPath, project.directory);

      await this.setStatus(exportJobId, projectId, ProjectExportStatus.Committing, { startedAt: new Date() });
      await this.gitService.commitWorkingTree(sourcePath, 'Export snapshot');

      await this.setStatus(exportJobId, projectId, ProjectExportStatus.Staging);
      const workspaceDir = path.join(stagingRoot, 'workspace');
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(stagingRoot, { recursive: true });
      await this.gitService.cloneLocal(sourcePath, workspaceDir);
      await this.gitService.removeOrigin(workspaceDir);

      const runtimeEntries = await this.projectFilesService.collectRuntimeEntries(sourcePath);
      for (const entry of runtimeEntries) {
        await this.copyEntry(entry, workspaceDir);
      }

      const schedules = await this.projectService.getSchedulesForExport(projectId);
      const manifest: ExportManifest = {
        title: project.title,
        description: project.description,
        agentName: agent?.slug ?? null,
        agent,
        settings: {
          timeoutIdle: project.timeoutIdle,
          appTimeoutIdle: project.appTimeoutIdle,
          requestLogMode: project.requestLogMode,
          requestLogBodyLimit: project.requestLogBodyLimit,
        },
        resources: {
          podClass: project.podClass,
          cpuMillicores: project.cpuMillicores,
          memoryRequestMib: project.memoryRequestMib,
          memoryLimitMib: project.memoryLimitMib,
        },
        appDetails: project.hasApp ? { name: project.appName, description: project.appDescription } : null,
        schedules,
        stamp: {
          exportFormatVersion: EXPORT_FORMAT_VERSION,
          platformVersion: this.platformVersion,
          agentImageVersion: this.agentImageVersion,
          arch: this.arch,
        },
      };
      await writeFile(path.join(stagingRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));

      await this.setStatus(exportJobId, projectId, ProjectExportStatus.Archiving);
      const entries = await this.collectArchiveEntries(stagingRoot);
      const bytesTotal = entries.reduce((total, entry) => total + entry.size, 0);
      await this.updateProgress(exportJobId, projectId, { bytesTotal, bytesProcessed: 0 });
      await this.writeArchive(entries, artifactPath, (bytesProcessed) =>
        this.updateProgress(exportJobId, projectId, { bytesProcessed })
      );

      const archiveStats = await stat(artifactPath);
      await this.markCompleted(exportJobId, projectId, {
        fileName: buildFileName(project.title),
        fileSize: archiveStats.size,
        bytesProcessed: archiveStats.size,
      });
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      this.logger.log(`Exported project ${projectId} (${archiveStats.size} bytes) in ${Date.now() - started}ms`);
    } catch (err) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      await rm(artifactPath, { force: true }).catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(exportJobId, projectId, userFacingExportError(message));
      this.logger.warn(`Failed to export project ${projectId}: ${message}`);
    }
  }

  private async copyEntry(entry: ProjectFileEntry, targetRoot: string): Promise<void> {
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
  }

  private async collectArchiveEntries(root: string): Promise<ArchiveEntry[]> {
    const entries: ArchiveEntry[] = [];
    const walk = async (dir: string, relDir: string): Promise<void> => {
      const children = await readdir(dir);
      for (const child of children) {
        const source = path.join(dir, child);
        const relPath = relDir ? `${relDir}/${child}` : child;
        const stats = await lstat(source);
        if (stats.isDirectory()) {
          await walk(source, relPath);
        } else if (stats.isSymbolicLink()) {
          entries.push({ source, relPath, type: 'symlink', mode: stats.mode, size: 0 });
        } else if (stats.isFile()) {
          entries.push({ source, relPath, type: 'file', mode: stats.mode, size: stats.size });
        }
      }
    };
    await walk(root, '');
    return entries;
  }

  private async writeArchive(
    entries: ArchiveEntry[],
    outPath: string,
    onProgress: (bytesProcessed: number) => Promise<void>
  ): Promise<void> {
    await mkdir(path.dirname(outPath), { recursive: true });
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    let lastPersistedAt = 0;
    archive.on('progress', (progress) => {
      const now = Date.now();
      if (now - lastPersistedAt < 1000) return;
      lastPersistedAt = now;
      void onProgress(progress.fs.processedBytes);
    });

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      output.on('error', reject);
      archive.on('warning', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.logger.warn(`Archive warning: ${err.message}`);
        } else {
          reject(err);
        }
      });
      archive.on('error', reject);
    });

    archive.pipe(output);
    for (const entry of entries) {
      const mode = entry.mode & 0o777;
      if (entry.type === 'symlink') {
        archive.symlink(entry.relPath, await readlink(entry.source), mode);
      } else {
        archive.file(entry.source, { name: entry.relPath, mode });
      }
    }
    await archive.finalize();
    await done;
  }

  private async setStatus(
    exportJobId: string,
    projectId: string,
    status: ProjectExportStatus,
    extra: Partial<typeof projectTransferJobs.$inferInsert> = {}
  ): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({ status, ...extra, updatedAt: new Date() })
      .where(eq(projectTransferJobs.id, exportJobId));
    await this.projectEventsService.publish(projectId);
  }

  private async updateProgress(
    exportJobId: string,
    projectId: string,
    progress: Partial<{ bytesTotal: number; bytesProcessed: number }>
  ): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({ ...progress, updatedAt: new Date() })
      .where(eq(projectTransferJobs.id, exportJobId));
    await this.projectEventsService.publish(projectId);
  }

  private async markCompleted(
    exportJobId: string,
    projectId: string,
    fields: { fileName: string; fileSize: number; bytesProcessed: number }
  ): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({
        status: ProjectExportStatus.Completed,
        fileName: fields.fileName,
        fileSize: fields.fileSize,
        bytesProcessed: fields.bytesProcessed,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectTransferJobs.id, exportJobId));
    await this.projectEventsService.publish(projectId);
  }

  private async markFailed(exportJobId: string, projectId: string, error: string): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({ status: ProjectExportStatus.Failed, error, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectTransferJobs.id, exportJobId));
    await this.projectEventsService.publish(projectId);
  }
}

function buildFileName(title: string | null): string {
  const base = (title ?? 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'project'}-export.zip`;
}

function userFacingExportError(message: string): string {
  if (/not a git repository|does not exist|ENOENT/i.test(message)) {
    return "Couldn't read the project's Development workspace. Please try again.";
  }
  return 'Export failed unexpectedly. Please try again.';
}
