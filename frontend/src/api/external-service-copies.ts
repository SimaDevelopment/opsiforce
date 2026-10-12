import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api, currentTenant } from './client';
import { externalServiceViewKeys, TENANT_SERVICES, type CustomServiceSummary } from './external-service-views';

export interface ServiceKeyLikeHit {
  path: string;
  reason: string;
}

export interface ServiceExportPreview {
  hits: ServiceKeyLikeHit[];
}

export interface ServiceCopy {
  service: CustomServiceSummary;
  warnings: string[];
}

export interface ServiceImportProblem {
  path: string;
  message: string;
}

export interface ServiceCopyName {
  name: string;
  slug: string;
}

export function useServiceExportPreview(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: [...externalServiceViewKeys.all, 'export-preview', id()] as const,
    queryFn: () => api.get<ServiceExportPreview>(`${TENANT_SERVICES}/${id()}/export/preview`),
    enabled: enabled(),
    staleTime: 0,
    reconcile: false as const,
  }));
}

export function downloadServiceExport(serviceId: string, slug: string): void {
  const tenant = currentTenant();
  const query = tenant ? `?${new URLSearchParams({ tenant }).toString()}` : '';
  const link = document.createElement('a');
  link.href = `/api${TENANT_SERVICES}/${serviceId}/export${query}`;
  link.download = `${slug}-service-export.zip`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function useDuplicateService(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (copy: ServiceCopyName) => api.post<ServiceCopy>(`${TENANT_SERVICES}/${id()}/duplicate`, copy),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList() });
    },
  }));
}

export function useImportService() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (request: Partial<ServiceCopyName> & { uploadId: string; fileName: string }) =>
      api.post<ServiceCopy>(`${TENANT_SERVICES}/import`, request),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList() });
    },
  }));
}
