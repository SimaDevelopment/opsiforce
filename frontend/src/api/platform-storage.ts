import { createMutation } from '@tanstack/solid-query';
import { api } from './client';
import { createAppQuery } from '~/lib/create-app-query';

export interface PlatformStorageEnvironment {
  id: string;
  environmentName: string;
  directory: string;
  bytes: number | null;
  error: boolean;
}

export interface PlatformStorageProject {
  id: string;
  title: string | null;
  totalBytes: number;
  error: boolean;
  environments: PlatformStorageEnvironment[];
}

export interface PlatformStoragePendingDeletion {
  bytes: number;
  count: number;
  error: boolean;
}

export interface PlatformStorageTemplates {
  bytes: number;
  count: number;
  error: boolean;
}

export interface PlatformStorageTenant {
  id: string;
  name: string;
  totalBytes: number;
  error: boolean;
  pendingDeletion: PlatformStoragePendingDeletion;
  templates: PlatformStorageTemplates;
  projects: PlatformStorageProject[];
}

export interface PlatformStorageBucket {
  bytes: number;
  error: boolean;
}

export interface PlatformStorageOrphanedBucket {
  bytes: number;
  count: number;
  error: boolean;
}

export interface PlatformStorageBuckets {
  pool: PlatformStorageBucket;
  tombstoned: PlatformStorageBucket;
  orphaned: PlatformStorageOrphanedBucket;
  templates: PlatformStorageTemplates;
  exports: PlatformStorageBucket;
  imports: PlatformStorageBucket;
}

export interface PlatformStorageView {
  capacityBytes: number;
  usedBytes: number;
  expectedCapacityBytes: number | null;
  capacitySuspect: boolean;
  computedAt: string;
  tenants: PlatformStorageTenant[];
  buckets: PlatformStorageBuckets;
  unaccountedBytes: number;
  incomplete: boolean;
}

export function usePlatformStorage() {
  return createAppQuery(() => ({
    queryKey: ['platform-storage'],
    queryFn: () => api.get<PlatformStorageView>('/platform/storage'),
  }));
}

export function useCleanupTenantStorage() {
  return createMutation(() => ({
    mutationFn: (tenantId: string) => api.post<{ enqueued: boolean }>('/platform/storage/cleanup', { tenantId }),
  }));
}
