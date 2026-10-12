import { api } from './client';
import { createAppQuery } from '~/lib/create-app-query';

export interface UsageCounters {
  calls: number;
  refused: number;
  failed: number;
  events: number;
}

export interface UsageEnvironmentBreakdown extends UsageCounters {
  projectEnvironmentId: string | null;
  environmentName: string | null;
  isDefault: boolean;
  deleted: boolean;
}

export interface UsageProjectBreakdown extends UsageCounters {
  projectId: string | null;
  projectTitle: string | null;
  deleted: boolean;
  environments: UsageEnvironmentBreakdown[];
}

export interface UsageServiceBreakdown extends UsageCounters {
  service: string;
  displayName: string;
  projects: UsageProjectBreakdown[];
}

export interface UsageView {
  month: string;
  services: UsageServiceBreakdown[];
}

export function useExternalServicesUsage(month: () => string) {
  return createAppQuery(() => ({
    queryKey: ['external-services-usage', month()],
    queryFn: () => api.get<UsageView>(`/external-services/admin/usage?month=${month()}`),
    reconcile: false,
  }));
}
