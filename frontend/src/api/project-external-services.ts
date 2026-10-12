import { createMutation, useQueryClient } from '@tanstack/solid-query';
import type { ServiceManifest } from '@opsiforce/external-service-sdk/forms';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import type {
  ConfigurationValues,
  ExternalServiceSummary,
  HookFailure,
  RevealedSecret,
  RotateTarget,
} from './external-service-views';

export type Switches = Record<string, boolean>;

export interface ProjectConfigurationState {
  saved: boolean;
  missing: string[];
  operationsOn: number;
  operationsTotal: number;
  receiving: number;
}

export type ProjectServiceState = 'enabled' | 'needs-configuration' | 'available';

export interface ProjectServiceSummary extends ExternalServiceSummary {
  state: ProjectServiceState;
  configuration: ProjectConfigurationState;
}

export interface ProjectServiceList {
  agentId: string;
  services: ProjectServiceSummary[];
}

export interface ProjectConfiguration {
  saved: boolean;
  values: ConfigurationValues;
  missing: string[];
  operations: Switches;
  receive: Switches;
  labels: Record<string, Record<string, string>>;
  newOperations: string[];
  newEventTypes: string[];
}

export interface ServiceConfigurationOptions {
  list: string;
  labelKey: string;
  options: { value: string; label: string }[];
}

export interface RemovedItemsNotice {
  removed: { label: string; fields: string[] }[];
}

export interface ProjectServiceView extends ExternalServiceSummary {
  state: ProjectServiceState;
  manifest: Omit<ServiceManifest, 'serviceForm'>;
  projectConfiguration: ProjectConfiguration;
  serviceConfigurationOptions: ServiceConfigurationOptions[];
  templateValues: Record<string, string>;
  hookFailure: HookFailure | null;
  notice: RemovedItemsNotice | null;
  revealed?: RevealedSecret[];
}

export interface ProjectEnvironmentRef {
  projectId: string;
  projectEnvironmentId: string;
}

function servicesPath(ref: ProjectEnvironmentRef): string {
  return `/external-services/projects/${ref.projectId}/environments/${ref.projectEnvironmentId}/services`;
}

export const projectExternalServiceKeys = {
  all: ['project-external-services'] as const,
  list: (ref: ProjectEnvironmentRef) =>
    [...projectExternalServiceKeys.all, ref.projectId, ref.projectEnvironmentId] as const,
  view: (ref: ProjectEnvironmentRef, serviceId: string) =>
    [...projectExternalServiceKeys.list(ref), serviceId] as const,
};

export function needsAttention(configuration: Pick<ProjectConfigurationState, 'saved' | 'missing'>): boolean {
  return configuration.saved && configuration.missing.length > 0;
}

export interface FormCallBody {
  values: ConfigurationValues;
  query?: string;
  item?: string;
}

export function callProjectForm(
  ref: ProjectEnvironmentRef,
  serviceId: string,
  route: 'options' | 'info' | 'buttons',
  name: string,
  body: FormCallBody
): Promise<unknown> {
  return api.post<unknown>(`${servicesPath(ref)}/${serviceId}/${route}/${encodeURIComponent(name)}`, body);
}

export function useProjectExternalServices(ref: () => ProjectEnvironmentRef) {
  return createAppQuery(() => ({
    queryKey: projectExternalServiceKeys.list(ref()),
    queryFn: () => api.get<ProjectServiceList>(servicesPath(ref())),
  }));
}

export function useProjectExternalService(ref: () => ProjectEnvironmentRef, serviceId: () => string) {
  return createAppQuery(() => ({
    queryKey: projectExternalServiceKeys.view(ref(), serviceId()),
    queryFn: () => api.get<ProjectServiceView>(`${servicesPath(ref())}/${serviceId()}`),
    reconcile: false,
    retry: false,
  }));
}

export function useSaveProjectConfiguration(ref: () => ProjectEnvironmentRef, serviceId: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (values: ConfigurationValues) =>
      api.put<ProjectServiceView>(`${servicesPath(ref())}/${serviceId()}/configuration`, { values }),
    onSuccess: (view: ProjectServiceView) => {
      qc.setQueryData(projectExternalServiceKeys.view(ref(), view.id), view);
      void qc.invalidateQueries({ queryKey: projectExternalServiceKeys.list(ref()), exact: true });
    },
  }));
}

function useProjectViewMutation<Input>(
  ref: () => ProjectEnvironmentRef,
  request: (input: Input) => Promise<ProjectServiceView>
) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: request,
    onSuccess: (view: ProjectServiceView) => {
      qc.setQueryData(projectExternalServiceKeys.view(ref(), view.id), view);
      void qc.invalidateQueries({ queryKey: projectExternalServiceKeys.list(ref()), exact: true });
    },
  }));
}

export function useRotateProjectConfiguration(ref: () => ProjectEnvironmentRef, serviceId: () => string) {
  return useProjectViewMutation(ref, (target: RotateTarget) =>
    api.post<ProjectServiceView>(`${servicesPath(ref())}/${serviceId()}/configuration/rotate`, target)
  );
}

export function useRetryProjectConfigurationHook(ref: () => ProjectEnvironmentRef, serviceId: () => string) {
  return useProjectViewMutation(ref, () =>
    api.post<ProjectServiceView>(`${servicesPath(ref())}/${serviceId()}/configuration/hook/retry`, {})
  );
}

export function useDiscardProjectConfigurationHook(ref: () => ProjectEnvironmentRef, serviceId: () => string) {
  return useProjectViewMutation(ref, () =>
    api.post<ProjectServiceView>(`${servicesPath(ref())}/${serviceId()}/configuration/hook/discard`, {})
  );
}
