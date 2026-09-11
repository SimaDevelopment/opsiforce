import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../db';
import { deletedProjectEnvironments, environments, projectEnvironments, projects, tenants } from '../../db/schema';
import { DIRECTORY_USAGE_STRATEGY, type DirectoryUsageStrategy } from './directory-usage.strategy';
import type {
  DirectoryUsage,
  PlatformStorageBucketsView,
  PlatformStorageBucketView,
  PlatformStorageEnvironmentView,
  PlatformStoragePendingDeletionView,
  PlatformStorageProjectView,
  PlatformStorageTenantView,
  PlatformStorageView,
} from './platform-storage.types';

const PROJECTS_ROOT = 'projects';
const EXPORTS_ROOT = 'exports';
const IMPORTS_ROOT = 'imports';
const CAPACITY_MISMATCH_RATIO = 2;

interface LiveEnvironmentRow {
  id: string;
  directory: string;
  isDefault: boolean;
  environmentName: string | null;
  projectId: string;
  projectTitle: string | null;
  tenantId: string | null;
}

interface TombstoneRow {
  tenantId: string | null;
  directory: string;
}

interface OrphanScan {
  directories: string[];
  error: boolean;
}

interface ClaimTotals {
  capacityBytes: number;
  usedBytes: number;
  expectedCapacityBytes: number | null;
  capacitySuspect: boolean;
}

@Injectable()
export class PlatformStorageSnapshotService {
  private readonly logger = new Logger(PlatformStorageSnapshotService.name);
  private readonly storageMountPath: string;
  private readonly configuredClaimBytes: number | null;

  constructor(
    private readonly configService: ConfigService,
    @Inject(DIRECTORY_USAGE_STRATEGY) private readonly directoryUsage: DirectoryUsageStrategy
  ) {
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.configuredClaimBytes = this.configService.get<number | null>('storageClaimBytes') ?? null;
  }

  async build(): Promise<PlatformStorageView> {
    const [claim, liveEnvironments, tombstones, tenantNames] = await Promise.all([
      this.readClaimTotals(),
      this.loadLiveEnvironments(),
      this.loadTombstones(),
      this.loadTenantNames(),
    ]);

    const orphanScan = await this.findOrphanedDirectories(liveEnvironments, tombstones);
    const usage = await this.directoryUsage.measure([
      ...liveEnvironments.map((row) => row.directory),
      ...tombstones.map((row) => row.directory),
      ...orphanScan.directories,
      EXPORTS_ROOT,
      IMPORTS_ROOT,
    ]);

    const tenantViews = this.buildTenants(liveEnvironments, tombstones, tenantNames, usage);
    const buckets = this.buildBuckets(liveEnvironments, tombstones, orphanScan, usage);

    const attributedBytes =
      tenantViews.reduce((total, tenant) => total + tenant.totalBytes, 0) +
      buckets.pool.bytes +
      buckets.tombstoned.bytes +
      buckets.orphaned.bytes +
      buckets.exports.bytes +
      buckets.imports.bytes;

    return {
      capacityBytes: claim.capacityBytes,
      usedBytes: claim.usedBytes,
      expectedCapacityBytes: claim.expectedCapacityBytes,
      capacitySuspect: claim.capacitySuspect,
      computedAt: new Date().toISOString(),
      tenants: tenantViews,
      buckets,
      unaccountedBytes: claim.usedBytes - attributedBytes,
      incomplete: orphanScan.error || [...usage.values()].some((entry) => entry.error),
    };
  }

  private async readClaimTotals(): Promise<ClaimTotals> {
    const [stats, quota] = await Promise.all([statfs(this.storageMountPath), this.directoryUsage.claimQuota()]);
    const capacityBytes = stats.bsize * stats.blocks;
    const expectedCapacityBytes = quota.state === 'enforced' ? quota.bytes : this.configuredClaimBytes;

    if (quota.state === 'absent') {
      this.logger.warn(
        `No quota is enforced on ${this.storageMountPath}, so statfs reports the underlying filesystem rather ` +
          `than the claim — capacity, used bytes and the unaccounted residual are not claim-scoped.`
      );
    }

    const capacityMismatch =
      expectedCapacityBytes !== null &&
      (capacityBytes > expectedCapacityBytes * CAPACITY_MISMATCH_RATIO ||
        capacityBytes * CAPACITY_MISMATCH_RATIO < expectedCapacityBytes);

    if (capacityMismatch) {
      this.logger.warn(
        `statfs on ${this.storageMountPath} reports ${capacityBytes} bytes of capacity but the claim is ` +
          `expected to hold ${expectedCapacityBytes} bytes — the quota may not be the one this claim was ` +
          `provisioned with.`
      );
    }

    return {
      capacityBytes,
      usedBytes: capacityBytes - stats.bsize * stats.bfree,
      expectedCapacityBytes,
      capacitySuspect: quota.state === 'absent' || capacityMismatch,
    };
  }

  private loadLiveEnvironments(): Promise<LiveEnvironmentRow[]> {
    return db
      .select({
        id: projectEnvironments.id,
        directory: projectEnvironments.directory,
        isDefault: projectEnvironments.isDefault,
        environmentName: environments.name,
        projectId: projectEnvironments.projectId,
        projectTitle: projects.title,
        tenantId: projects.tenantId,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .leftJoin(environments, eq(environments.id, projectEnvironments.environmentId)) as Promise<LiveEnvironmentRow[]>;
  }

  private loadTombstones(): Promise<TombstoneRow[]> {
    return db
      .select({ tenantId: deletedProjectEnvironments.tenantId, directory: deletedProjectEnvironments.directory })
      .from(deletedProjectEnvironments);
  }

  private async loadTenantNames(): Promise<Map<string, string>> {
    const rows = await db.select({ id: tenants.id, displayName: tenants.displayName }).from(tenants);
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  private async findOrphanedDirectories(
    liveEnvironments: LiveEnvironmentRow[],
    tombstones: TombstoneRow[]
  ): Promise<OrphanScan> {
    const knownDirectories = new Set<string>([
      ...liveEnvironments.map((row) => row.directory),
      ...tombstones.map((row) => row.directory),
    ]);

    const keepPrefixes = new Set<string>();
    for (const directory of knownDirectories) {
      let prefix = path.posix.dirname(directory);
      while (prefix !== '.' && prefix !== path.posix.sep) {
        keepPrefixes.add(prefix);
        const parent = path.posix.dirname(prefix);
        if (parent === prefix) break;
        prefix = parent;
      }
    }

    const orphaned: string[] = [];
    const pending = [PROJECTS_ROOT];
    let scanFailed = false;

    while (pending.length > 0) {
      const relativeDirectory = pending.pop();
      if (relativeDirectory === undefined) break;
      const entries = await readdir(path.join(this.storageMountPath, relativeDirectory), {
        withFileTypes: true,
      }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          scanFailed = true;
          this.logger.warn(`Failed to scan ${relativeDirectory} for orphans: ${err.message}`);
        }
        return [];
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childDirectory = path.posix.join(relativeDirectory, entry.name);
        if (knownDirectories.has(childDirectory)) continue;
        if (keepPrefixes.has(childDirectory)) pending.push(childDirectory);
        else orphaned.push(childDirectory);
      }
    }

    return { directories: orphaned, error: scanFailed };
  }

  private buildTenants(
    liveEnvironments: LiveEnvironmentRow[],
    tombstones: TombstoneRow[],
    tenantNames: Map<string, string>,
    usage: Map<string, DirectoryUsage>
  ): PlatformStorageTenantView[] {
    const environmentsByTenantProject = new Map<string, Map<string, PlatformStorageEnvironmentView[]>>();
    const projectTitles = new Map<string, string | null>();

    for (const row of liveEnvironments) {
      if (row.tenantId === null) continue;
      const byProject =
        environmentsByTenantProject.get(row.tenantId) ?? new Map<string, PlatformStorageEnvironmentView[]>();
      environmentsByTenantProject.set(row.tenantId, byProject);
      const environmentViews: PlatformStorageEnvironmentView[] = byProject.get(row.projectId) ?? [];
      byProject.set(row.projectId, environmentViews);
      projectTitles.set(row.projectId, row.projectTitle);
      environmentViews.push({
        id: row.id,
        environmentName: environmentLabel(row.environmentName, row.isDefault),
        directory: row.directory,
        ...bytesOf(usage, row.directory),
      });
    }

    const pendingDeletionByTenant = new Map<string, PlatformStoragePendingDeletionView>();
    for (const row of tombstones) {
      if (row.tenantId === null) continue;
      const aggregate = pendingDeletionByTenant.get(row.tenantId) ?? emptyPendingDeletion();
      const measured = bytesOf(usage, row.directory);
      aggregate.bytes += measured.bytes ?? 0;
      aggregate.count += 1;
      aggregate.error = aggregate.error || measured.error;
      pendingDeletionByTenant.set(row.tenantId, aggregate);
    }

    const tenantIds = new Set<string>([...environmentsByTenantProject.keys(), ...pendingDeletionByTenant.keys()]);

    return [...tenantIds]
      .map((tenantId) => {
        const projectViews = [
          ...(
            environmentsByTenantProject.get(tenantId) ?? new Map<string, PlatformStorageEnvironmentView[]>()
          ).entries(),
        ]
          .map(([projectId, environmentViews]) => ({
            id: projectId,
            title: projectTitles.get(projectId) ?? null,
            totalBytes: environmentViews.reduce((total, view) => total + (view.bytes ?? 0), 0),
            error: environmentViews.some((view) => view.error),
            environments: environmentViews.toSorted(compareEnvironments),
          }))
          .toSorted(compareProjects);
        const pendingDeletion = pendingDeletionByTenant.get(tenantId) ?? emptyPendingDeletion();

        return {
          id: tenantId,
          name: tenantNames.get(tenantId) ?? tenantId,
          totalBytes: projectViews.reduce((total, project) => total + project.totalBytes, 0) + pendingDeletion.bytes,
          error: projectViews.some((project) => project.error) || pendingDeletion.error,
          pendingDeletion,
          projects: projectViews,
        };
      })
      .toSorted(compareTenants);
  }

  private buildBuckets(
    liveEnvironments: LiveEnvironmentRow[],
    tombstones: TombstoneRow[],
    orphanScan: OrphanScan,
    usage: Map<string, DirectoryUsage>
  ): PlatformStorageBucketsView {
    const sum = (directories: string[]): PlatformStorageBucketView =>
      directories.reduce<PlatformStorageBucketView>(
        (aggregate, directory) => {
          const measured = bytesOf(usage, directory);
          return { bytes: aggregate.bytes + (measured.bytes ?? 0), error: aggregate.error || measured.error };
        },
        { bytes: 0, error: false }
      );

    const orphaned = sum(orphanScan.directories);

    return {
      pool: sum(liveEnvironments.filter((row) => row.tenantId === null).map((row) => row.directory)),
      tombstoned: sum(tombstones.filter((row) => row.tenantId === null).map((row) => row.directory)),
      orphaned: {
        bytes: orphaned.bytes,
        error: orphaned.error || orphanScan.error,
        count: orphanScan.directories.length,
      },
      exports: sum([EXPORTS_ROOT]),
      imports: sum([IMPORTS_ROOT]),
    };
  }
}

function bytesOf(usage: Map<string, DirectoryUsage>, directory: string): DirectoryUsage {
  return usage.get(directory) ?? { bytes: null, error: true };
}

function emptyPendingDeletion(): PlatformStoragePendingDeletionView {
  return { bytes: 0, count: 0, error: false };
}

function environmentLabel(environmentName: string | null, isDefault: boolean): string {
  return environmentName ?? (isDefault ? 'Development' : 'Environment');
}

function compareEnvironments(a: PlatformStorageEnvironmentView, b: PlatformStorageEnvironmentView): number {
  return (b.bytes ?? 0) - (a.bytes ?? 0) || a.environmentName.localeCompare(b.environmentName);
}

function compareProjects(a: PlatformStorageProjectView, b: PlatformStorageProjectView): number {
  return b.totalBytes - a.totalBytes || (a.title ?? a.id).localeCompare(b.title ?? b.id);
}

function compareTenants(a: PlatformStorageTenantView, b: PlatformStorageTenantView): number {
  return b.totalBytes - a.totalBytes || a.name.localeCompare(b.name);
}
