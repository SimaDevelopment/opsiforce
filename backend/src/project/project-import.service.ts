import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'node:path';
import { chmod, lstat, mkdir, rename, rm, symlink } from 'node:fs/promises';
import type yauzl from 'yauzl';
import { db } from '../../db';
import { folders, projectTransferJobs, workspaceMembers, workspaces } from '../../db/schema';
import { AgentService } from '../agent/agent.service';
import { restoreOwner, type FileOwner } from '../common/fs';
import {
  collectEntries,
  entryMode,
  isSymlinkMode,
  openZip,
  readEntry,
  readNamedEntry,
  writeEntryToFile,
} from '../common/zip-reader';
import { TenantService } from '../tenant/tenant.service';
import { ProjectService } from './project.service';
import { ProjectEventsService } from './project-events.service';
import { PROJECT_EXPORT_KIND, type ExportManifest, type ExportManifestOwner } from '../export/project-export.types';
import { EXPORT_MANIFEST_FILE, wrongExportKind } from '../export/export-manifest';
import {
  importsRootPath,
  PROJECT_IMPORT_QUEUE,
  ProjectImportJobData,
  ProjectImportJobResponse,
  ProjectImportStatus,
  type StartImportResult,
} from './project-import.types';

const WORKSPACE_PREFIX = 'workspace/';
const MAX_OWNER_ID = 0xfffffffe;

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
      return {
        agentId: await this.agentService.getDefaultAgentId(tenantId),
        importedAgent: null,
        agentFallbackFrom: null,
      };

    const agentId = await this.agentService.findIdByName(slug, tenantId);
    if (agentId) return { agentId, importedAgent: null, agentFallbackFrom: null };

    this.logger.warn(`Imported agent "${slug}" not found; linking the default agent and recording the original`);
    return {
      agentId: await this.agentService.getDefaultAgentId(tenantId),
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
      const buffer = await readNamedEntry(zip, 'manifest.json');
      if (!buffer) throw new BadRequestException('The file is not a valid project export (missing manifest).');
      const manifest = JSON.parse(buffer.toString('utf8')) as ExportManifest;
      if (typeof manifest !== 'object' || manifest === null || !manifest.stamp) {
        throw malformedManifest();
      }
      assertProjectExportKind(manifest);
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
   * restoring directories (empty ones included), file and directory modes, the
   * owners the manifest records, and symlinks. Writes are confined to the target
   * directory: an entry whose path escapes it, or that would be placed through or
   * over a symlink, is rejected.
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
      const owners = await recordedOwners(zip, entries, root);
      const bytesTotal = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
      await report(0, bytesTotal);

      await mkdir(root, { recursive: true });
      const directories = new Set<string>();
      let bytesProcessed = 0;
      let lastReportedAt = 0;
      const directoryModes: Array<{ target: string; perms: number; owner: FileOwner | undefined }> = [];

      for (const entry of entries) {
        if (!entry.fileName.startsWith(WORKSPACE_PREFIX)) continue;
        const target = resolveConfined(root, entry.fileName.slice(WORKSPACE_PREFIX.length));
        if (target === root) continue;

        const mode = entryMode(entry);
        const owner = owners.get(target);

        if (entry.fileName.endsWith('/')) {
          await ensureDirectory(root, target, directories);
          directoryModes.push({ target, perms: mode & 0o777, owner });
          continue;
        }

        await ensureDirectory(root, path.dirname(target), directories);

        if (isSymlinkMode(mode)) {
          const linkBuffer = await readEntry(zip, entry);
          const linkTarget = linkBuffer.toString('utf8');
          if (!isConfined(root, path.resolve(path.dirname(target), linkTarget))) {
            throw new BadRequestException('The project export contains an unsafe symlink.');
          }
          await symlink(linkTarget, target).catch(refuseExisting);
          if (owner) await restoreOwner(target, owner);
          continue;
        }

        await writeEntryToFile(zip, entry, target).catch(refuseExisting);
        if (owner) await restoreOwner(target, owner);
        const perms = mode & 0o777;
        if (perms) await chmod(target, perms);

        bytesProcessed += entry.uncompressedSize;
        const now = Date.now();
        if (now - lastReportedAt >= 1000) {
          lastReportedAt = now;
          await report(bytesProcessed, bytesTotal);
        }
      }

      for (const { target, perms, owner } of directoryModes.toSorted((a, b) => depth(b.target) - depth(a.target))) {
        if (owner) await restoreOwner(target, owner);
        if (perms) await chmod(target, perms);
      }

      await report(bytesProcessed, bytesTotal);
    } finally {
      zip.close();
    }
  }
}

async function recordedOwners(
  zip: yauzl.ZipFile,
  entries: yauzl.Entry[],
  root: string
): Promise<Map<string, FileOwner>> {
  const manifestEntry = entries.find((entry) => entry.fileName === EXPORT_MANIFEST_FILE);
  const recorded = manifestEntry
    ? (JSON.parse((await readEntry(zip, manifestEntry)).toString('utf8')) as ExportManifest).owners
    : undefined;
  const owners = new Map<string, FileOwner>();
  if (recorded === undefined) return owners;
  if (!Array.isArray(recorded)) throw malformedManifest();
  for (const owner of recorded as unknown[]) {
    const { path: rel, uid, gid } = (owner ?? {}) as Partial<Record<keyof ExportManifestOwner, unknown>>;
    if (typeof rel !== 'string' || !isOwnerId(uid) || !isOwnerId(gid)) throw malformedManifest();
    owners.set(resolveConfined(root, rel), { uid, gid });
  }
  return owners;
}

function isOwnerId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id <= MAX_OWNER_ID;
}

function malformedManifest(): BadRequestException {
  return new BadRequestException('The project export manifest is malformed.');
}

function depth(target: string): number {
  return target.split(path.sep).length;
}

export function assertProjectExportKind(manifest: { kind?: unknown }): void {
  const wrongKind = wrongExportKind(manifest, PROJECT_EXPORT_KIND);
  if (wrongKind) throw new BadRequestException(wrongKind);
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
  if (!isConfined(root, target)) throw unsafeFilePath();
  return target;
}

async function ensureDirectory(root: string, dir: string, directories: Set<string>): Promise<void> {
  if (dir === root || directories.has(dir)) return;
  if (!isConfined(root, dir)) throw unsafeFilePath();
  await ensureDirectory(root, path.dirname(dir), directories);
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!(await lstat(dir)).isDirectory()) throw unsafeFilePath();
  }
  directories.add(dir);
}

function refuseExisting(err: NodeJS.ErrnoException): never {
  throw err.code === 'EEXIST' ? unsafeFilePath() : err;
}

function unsafeFilePath(): BadRequestException {
  return new BadRequestException('The project export contains an unsafe file path.');
}
