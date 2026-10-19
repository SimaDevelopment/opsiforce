import { keepPreviousData } from '@tanstack/solid-query';
import { cursorQuery, type CursorPage, type PageCursor } from '~/components/pager';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import { TENANT_SERVICES } from './external-service-views';
import type { ProjectEnvironmentRef } from './project-external-services';

export type CallLogOutcome = 'proxied' | 'handled' | 'not supported' | 'not allowed' | 'failed';

export type CallLogOutcomeFilter = 'allowed' | 'not supported' | 'not allowed' | 'failed';

export type CallLogCallerKind = 'call' | 'platform';

export type CallLogTimeRange = '1h' | '24h' | '7d' | '30d';

export type ServiceCopy = 'default' | 'development';

export interface CallLogEntry {
  requestId: string;
  time: string;
  callerKind: CallLogCallerKind;
  projectId: string | null;
  projectTitle: string | null;
  projectEnvironmentId: string | null;
  environment: string | null;
  environmentName: string | null;
  method: string;
  path: string;
  route: string | null;
  outcome: CallLogOutcome;
  reason: string | null;
  status: number;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  notes: Record<string, unknown>;
}

export interface CallLogPage extends CursorPage {
  calls: CallLogEntry[];
  projects: { projectId: string; title: string | null }[];
  retentionDays: number;
}

export interface CallLogFilters {
  cursor: PageCursor;
  outcome: CallLogOutcomeFilter | null;
  projectId: string | null;
  since: CallLogTimeRange | null;
}

export const CALL_LOG_REFRESH_MS = 10_000;

export const RECORDS_BUSY = 'records-busy';

export const RECORDS_UNREADABLE = 'records-unreadable';

export const callLogSources = {
  tenantService: (serviceId: string, copy: ServiceCopy) => `${TENANT_SERVICES}/${serviceId}/call-log?copy=${copy}`,
  projectEnvironment: (environment: ProjectEnvironmentRef, serviceId: string) =>
    `/external-services/projects/${environment.projectId}/environments/${environment.projectEnvironmentId}/services/${serviceId}/call-log`,
};

function callLogUrl(source: string, filters: CallLogFilters): string {
  const [path, existing] = source.split('?');
  const params = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(cursorQuery(filters.cursor))) params.set(key, value);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.projectId) params.set('project', filters.projectId);
  if (filters.since) params.set('since', filters.since);
  const query = params.toString();
  return query ? `${path}?${query}` : (path ?? source);
}

export function useCallLogPage(source: () => string, filters: () => CallLogFilters) {
  return createAppQuery(() => ({
    queryKey: ['external-service-call-log', source(), filters()],
    queryFn: () => api.get<CallLogPage>(callLogUrl(source(), filters())),
    placeholderData: keepPreviousData,
    refetchInterval: filters().cursor === null ? CALL_LOG_REFRESH_MS : false,
    refetchIntervalInBackground: false,
    reconcile: false,
    retry: false,
  }));
}
