export type ClaimQuota = { state: 'enforced'; bytes: number } | { state: 'absent' } | { state: 'unreadable' };

export interface DirectoryUsage {
  bytes: number | null;
  error: boolean;
}

export interface PlatformStorageEnvironmentView {
  id: string;
  environmentName: string;
  directory: string;
  bytes: number | null;
  error: boolean;
}

export interface PlatformStorageProjectView {
  id: string;
  title: string | null;
  totalBytes: number;
  error: boolean;
  environments: PlatformStorageEnvironmentView[];
}

export interface PlatformStoragePendingDeletionView {
  bytes: number;
  count: number;
  error: boolean;
}

export interface PlatformStorageTemplatesView {
  bytes: number;
  count: number;
  error: boolean;
}

export interface PlatformStorageTenantView {
  id: string;
  name: string;
  totalBytes: number;
  error: boolean;
  pendingDeletion: PlatformStoragePendingDeletionView;
  templates: PlatformStorageTemplatesView;
  projects: PlatformStorageProjectView[];
}

export interface PlatformStorageBucketView {
  bytes: number;
  error: boolean;
}

export interface PlatformStorageOrphanedBucketView {
  bytes: number;
  count: number;
  error: boolean;
}

export interface PlatformStorageBucketsView {
  pool: PlatformStorageBucketView;
  tombstoned: PlatformStorageBucketView;
  orphaned: PlatformStorageOrphanedBucketView;
  templates: PlatformStorageTemplatesView;
  exports: PlatformStorageBucketView;
  imports: PlatformStorageBucketView;
}

export interface PlatformStorageView {
  capacityBytes: number;
  usedBytes: number;
  expectedCapacityBytes: number | null;
  capacitySuspect: boolean;
  computedAt: string;
  tenants: PlatformStorageTenantView[];
  buckets: PlatformStorageBucketsView;
  unaccountedBytes: number;
  incomplete: boolean;
}
