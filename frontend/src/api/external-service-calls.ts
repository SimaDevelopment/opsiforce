import { keepPreviousData } from '@tanstack/solid-query';
import { cursorQuery, type CursorPage, type PageCursor } from '~/components/pager';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import { PLATFORM_SERVICES, TENANT_SERVICES } from './external-service-views';
import type { ProjectEnvironmentRef } from './project-external-services';

export type CallOutcome = 'allowed' | 'refused' | 'failed';

export type CallKind = 'operation' | 'form' | 'hook' | 'inbound' | 'delivery';

export interface TouchedBound {
  bound: string;
  pointer?: string;
  value: unknown;
  label?: string;
}

export interface ServiceCall {
  callId: string;
  createdAt: string;
  kind: CallKind;
  via: 'agent' | 'app' | 'form' | null;
  operation: string | null;
  operationKind: string | null;
  outcome: CallOutcome;
  status: number;
  code: string | null;
  detail: string | null;
  bounds: TouchedBound[] | null;
  inputBytes: number | null;
  outputBytes: number | null;
  durationMs: number;
  serviceId: string | null;
  slug: string;
  tenantId: string | null;
  tenantName: string | null;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environmentName: string | null;
  servedBy: string | null;
}

export interface CallPage extends CursorPage {
  calls: ServiceCall[];
  retentionDays: number;
}

export interface CallFilters {
  cursor: PageCursor;
  search: string;
  outcome: CallOutcome | null;
}

export const callSources = {
  platformService: (serviceId: string) => `${PLATFORM_SERVICES}/${serviceId}/calls`,
  tenantService: (serviceId: string) => `${TENANT_SERVICES}/${serviceId}/calls`,
  tenant: () => '/external-services/admin/calls',
  projectEnvironment: (environment: ProjectEnvironmentRef, serviceId: string) =>
    `/external-services/projects/${environment.projectId}/environments/${environment.projectEnvironmentId}/services/${serviceId}/calls`,
};

function callPageUrl(source: string, filters: CallFilters): string {
  const params = new URLSearchParams(cursorQuery(filters.cursor));
  if (filters.search) params.set('q', filters.search);
  if (filters.outcome) params.set('outcome', filters.outcome);
  const query = params.toString();
  return query ? `${source}?${query}` : source;
}

export function useCallPage(source: () => string, filters: () => CallFilters, enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: ['external-service-calls', source(), filters()],
    queryFn: () => api.get<CallPage>(callPageUrl(source(), filters())),
    enabled: enabled(),
    placeholderData: keepPreviousData,
    reconcile: false,
    retry: false,
  }));
}
