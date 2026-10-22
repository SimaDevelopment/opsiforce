import { keepPreviousData } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import type { ServiceCopy } from './external-service-call-log';
import { TENANT_SERVICES } from './external-service-views';

export type UsageValues = Record<string, number>;

export interface UsageCounter {
  name: string;
  label: string;
  description: string | null;
  builtIn: boolean;
}

export interface UsageEnvironment {
  projectEnvironmentId: string | null;
  environmentName: string | null;
  values: UsageValues;
}

export interface UsageProject {
  projectId: string | null;
  title: string | null;
  deleted: boolean;
  values: UsageValues;
  environments: UsageEnvironment[];
}

export interface ServiceUsageView {
  months: string[];
  month: string | null;
  counters: UsageCounter[];
  projects: UsageProject[];
  service: UsageValues | null;
  totals: UsageValues;
}

function usageUrl(serviceId: string, copy: ServiceCopy, month: string | null): string {
  const params = new URLSearchParams({ copy });
  if (month) params.set('month', month);
  return `${TENANT_SERVICES}/${serviceId}/usage?${params.toString()}`;
}

export function useServiceUsage(serviceId: () => string, copy: () => ServiceCopy, month: () => string | null) {
  return createAppQuery(() => ({
    queryKey: ['external-service-usage', serviceId(), copy(), month()],
    queryFn: () => api.get<ServiceUsageView>(usageUrl(serviceId(), copy(), month())),
    placeholderData: keepPreviousData,
    reconcile: false,
    retry: false,
  }));
}
