import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'node:path';
import { chmod, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { db } from '../../db';
import { folders, projectTransferJobs, workspaceMembers, workspaces } from '../../db/schema';
import { AgentService } from '../agent/agent.service';
import { TenantService } from '../tenant/tenant.service';
import { ProjectService } from './project.service';
import { ProjectEventsService } from './project-events.service';
import type { ExportManifest } from '../export/project-export.types';
import {
  importsRootPath,
  PROJECT_IMPORT_QUEUE,
  ProjectImportJobData,
  ProjectImportJobResponse,
  ProjectImportStatus,
  type StartImportResult,
} from './project-import.types';

const WORKSPACE_PREFIX = 'workspace/';
const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

@Injectable()
export class ProjectImportService {
  private readonly logger = new Logger(ProjectImportService.name);
  private readonly storageMountPath: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly agentService: AgentService,
    private readonly tenantService: TenantService,
    @InjectQueue(PROJECT_IMPORT_QUEUE)
    private readonly queue: Queue<ProjectImportJobData>
  ) {
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
  }

  importsDir(): string {
    return importsRootPath(this.storageMountPath);
  }

  newUploadPath(): string {
    return path.join(this.importsDir(), `.${crypto.randomUUID()}.upload`);
  }

  archivePath(importJobId: string): string {
    return path.join(this.importsDir(), `${importJobId}.zip`);
  }

  async startImport(params: {
    tenantId: string;
    workspaceId: string | null;
    folderId: string | null;
    userId: string;
    canManageWorkspaces: boolean;
    titleOverride: string | null;
    timezone: string;
    uploadPath: string;
  }): Promise<StartImportResult> {
    const { tenantId, workspaceId, folderId, userId, canManageWorkspaces, titleOverride, timezone, uploadPath } =
      params;

    if (workspaceId) await this.assertWorkspaceAccessible(workspaceId, tenantId, userId, canManageWorkspaces);
    const targetFolderId = workspaceId && folderId ? await this.resolveFolder(folderId, workspaceId) : null;

    const manifest = await this.readManifest(uploadPath);
    const { agentId, importedAgent, agentFallbackFrom } = await this.resolveAgent(manifest, tenantId);
    const title = titleOverride?.trim() || manifest.title;

    const project = await this.projectService.createImportedProject({
      tenantId,
      workspaceId,
      folderId: targetFolderId,
      title,
      timezone,
      agentId,
      importedAgent,
      description: manifest.description ?? null,
      settings: manifest.settings ?? null,
      resources: manifest.resources ?? null,
      appDetails: manifest.appDetails ?? null,
      schedules: manifest.schedules ?? [],
      createdBy: userId,
    });

    const importJobId = crypto.randomUUID();
    const archivePath = this.archivePath(importJobId);

    try {
      await rename(uploadPath, archivePath);
      await db.insert(projectTransferJobs).values({
        id: importJobId,
        kind: 'import',
        projectId: project.id,
        tenantId,
        status: ProjectImportStatus.Queued,
        agentFallbackFrom,
      });
      await this.queue.add(
        'import',
        { importJobId, projectId: project.id, tenantId, archivePath },
        { jobId: importJobId, attempts: 1, removeOnComplete: true, removeOnFail: 1000 }
      );
    } catch (err) {
      await rm(uploadPath, { force: true }).catch(() => {});
      await rm(archivePath, { force: true }).catch(() => {});
      await this.projectService.discardHalfCreatedProject(project.id).catch(() => {});
      throw err;
    }

    await this.projectEventsService.publish(project.id);
    return { projectId: project.id, job: await this.getJob(importJobId) };
  }

  private async assertWorkspaceAccessible(
    workspaceId: string,
    tenantId: string,
    userId: string,
    canManageWorkspaces: boolean
  ): Promise<void> {
    const [workspace] = await db
      .select({ type: workspaces.type })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.tenantId, tenantId)))
      .limit(1);
    if (!workspace) throw new NotFoundException(`Workspace ${workspaceId} not found`);

    if (workspace.type === 'private' && !(await this.tenantService.isPrivateWorkspaceEnabled(tenantId))) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    const adminBypass = canManageWorkspaces && workspace.type === 'shared';
    if (adminBypass) return;

    const [member] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    if (!member) throw new NotFoundException(`Workspace ${workspaceId} not found`);
  }

  private async resolveFolder(folderId: string, workspaceId: string): Promise<string> {
    const [folder] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
      .limit(1);
    if (!folder) throw new NotFoundException(`Folder ${folderId} not found`);
    return folder.id;
  }

  private async resolveAgent(
    manifest: ExportManifest,
    tenantId: string
  ): Promise<{ agentId: string; importedAgent: string | null; agentFallbackFrom: string | null }> {
    const slug = manifest.agent?.slug ?? manifest.agentName;
    if (!slug)
      return { agentId: await this.agentService.getDefaultAgentId(), importedAgent: null, agentFallbackFrom: null };

    const agentId = await this.agentService.findIdByName(slug, tenantId);
    if (agentId) return { agentId, importedAgent: null, agentFallbackFrom: null };

    this.logger.warn(`Imported agent "${slug}" not found; linking the default agent and recording the original`);
    return {
      agentId: await this.agentService.getDefaultAgentId(),
      importedAgent: slug,
      agentFallbackFrom: manifest.agent?.displayName ?? slug,
    };
  }

  async getLatestJob(projectId: string): Promise<ProjectImportJobResponse | null> {
    const [row] = await db
      .select()
      .from(projectTransferJobs)
      .where(and(eq(projectTransferJobs.kind, 'import'), eq(projectTransferJobs.projectId, projectId)))
      .orderBy(desc(projectTransferJobs.createdAt))
      .limit(1);
    return row ? toResponse(row) : null;
  }

  async getJob(importJobId: string): Promise<ProjectImportJobResponse> {
    const [row] = await db.select().from(projectTransferJobs).where(eq(projectTransferJobs.id, importJobId));
    if (!row) throw new NotFoundException(`Import job ${importJobId} not found`);
    return toResponse(row);
  }

  async setStatus(importJobId: string, projectId: string, status: ProjectImportStatus): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({
        status,
        updatedAt: new Date(),
        ...(status === ProjectImportStatus.Unpacking ? { startedAt: new Date() } : {}),
      })
      .where(eq(projectTransferJobs.id, importJobId));
    await this.projectEventsService.publish(projectId);
  }

  async updateProgress(
    importJobId: string,
    projectId: string,
    progress: Partial<{ bytesTotal: number; bytesProcessed: number }>
  ): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({ ...progress, updatedAt: new Date() })
      .where(eq(projectTransferJobs.id, importJobId));
    await this.projectEventsService.publish(projectId);
  }

  async markFailed(importJobId: string, projectId: string, error: string): Promise<void> {
    await db
      .update(projectTransferJobs)
      .set({ status: ProjectImportStatus.Failed, error, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectTransferJobs.id, importJobId));
    await this.projectEventsService.publish(projectId);
  }

  private async readManifest(archivePath: string): Promise<ExportManifest> {
    let zip: yauzl.ZipFile | null = null;
    try {
      zip = await openZip(archivePath);
      const buffer = await readEntryBuffer(zip, 'manifest.json');
      if (!buffer) throw new BadRequestException('The file is not a valid project export (missing manifest).');
      const manifest = JSON.parse(buffer.toString('utf8')) as ExportManifest;
      if (typeof manifest !== 'object' || manifest === null || !manifest.stamp) {
        throw new BadRequestException('The project export manifest is malformed.');
      }
      return manifest;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('The file is not a valid project export.');
    } finally {
      zip?.close();
    }
  }

  /**
   * Unpacks the bundle's `workspace/` tree into the target project directory,
   * restoring file modes and symlinks. Writes are confined to the target
   * directory: an entry whose path escapes it is rejected.
   */
  async unpack(
    archivePath: string,
    projectDir: string,
    report: (bytesProcessed: number, bytesTotal: number) => Promise<void>
  ): Promise<void> {
    const root = path.resolve(projectDir);
    const zip = await openZip(archivePath);
    try {
      const entries = await collectEntries(zip);
      const bytesTotal = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
      await report(0, bytesTotal);

      await mkdir(root, { recursive: true });
      let bytesProcessed = 0;
      let lastReportedAt = 0;

      for (const entry of entries) {
        if (!entry.fileName.startsWith(WORKSPACE_PREFIX)) continue;
        const rel = entry.fileName.slice(WORKSPACE_PREFIX.length);
        if (rel.length === 0) continue;

        const target = resolveConfined(root, rel);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;

        if (entry.fileName.endsWith('/')) {
          await mkdir(target, { recursive: true });
          continue;
        }

        await mkdir(path.dirname(target), { recursive: true });

        if ((mode & FILE_TYPE_MASK) === SYMLINK_MODE) {
          const linkBuffer = await readEntryStream(zip, entry);
          const linkTarget = linkBuffer.toString('utf8');
          if (!isConfined(root, path.resolve(path.dirname(target), linkTarget))) {
            throw new BadRequestException('The project export contains an unsafe symlink.');
          }
          await symlink(linkTarget, target);
          continue;
        }

        await writeEntryToFile(zip, entry, target);
        const perms = mode & 0o777;
        if (perms) await chmod(target, perms);

        bytesProcessed += entry.uncompressedSize;
        const now = Date.now();
        if (now - lastReportedAt >= 1000) {
          lastReportedAt = now;
          await report(bytesProcessed, bytesTotal);
        }
      }

      await report(bytesProcessed, bytesTotal);
    } finally {
      zip.close();
    }
  }
}

function toResponse(row: typeof projectTransferJobs.$inferSelect): ProjectImportJobResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as ProjectImportStatus,
    bytesTotal: row.bytesTotal,
    bytesProcessed: row.bytesProcessed,
    agentFallbackFrom: row.agentFallbackFrom,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isConfined(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function resolveConfined(root: string, rel: string): string {
  const target = path.resolve(root, rel);
  if (!isConfined(root, target)) {
    throw new BadRequestException('The project export contains an unsafe file path.');
  }
  return target;
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error('Failed to open archive'));
        return;
      }
      resolve(zip);
    });
  });
}

function collectEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error('Failed to read archive entry'));
      else resolve(stream);
    });
  });
}

async function readEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function readEntryBuffer(zip: yauzl.ZipFile, name: string): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName !== name) {
        zip.readEntry();
        return;
      }
      readEntryStream(zip, entry).then(resolve, reject);
    });
    zip.on('end', () => resolve(null));
    zip.on('error', reject);
    zip.readEntry();
  });
}

async function writeEntryToFile(zip: yauzl.ZipFile, entry: yauzl.Entry, target: string): Promise<void> {
  const stream = await openEntryStream(zip, entry);
  await pipeline(stream, createWriteStream(target));
}
