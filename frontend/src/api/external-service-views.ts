import { createMutation, useQueryClient } from '@tanstack/solid-query';
import type { ServiceManifest } from '@opsiforce/external-service-sdk/forms';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';

export const PLATFORM_SERVICES = '/external-services/platform/services';
export const TENANT_SERVICES = '/external-services/services';

export function serviceBase(origin: ExternalServiceOrigin): string {
  return origin === 'custom' ? TENANT_SERVICES : PLATFORM_SERVICES;
}

export type ExternalServiceOrigin = 'built_in' | 'custom';

export type ConfigurationValues = Record<string, unknown>;

export interface ExternalServiceSummary {
  id: string;
  slug: string;
  origin: ExternalServiceOrigin;
  displayName: string;
  description: string;
  icon: string | null;
}

export interface OperatorServiceSummary extends ExternalServiceSummary {
  available: boolean;
}

export interface HookFailure {
  callId: string;
  code: string;
  detail: string | null;
}

export interface RevealedSecret {
  path: string;
  value: string;
}

export function withRevealed(
  shown: ReadonlyMap<string, string>,
  revealed: readonly RevealedSecret[] | undefined
): ReadonlyMap<string, string> {
  return new Map([...shown, ...(revealed ?? []).map((entry) => [entry.path, entry.value] as const)]);
}

export interface RotateTarget {
  field: string;
  item?: string;
}

export interface OperatorServiceView extends OperatorServiceSummary {
  manifest: ServiceManifest;
  serviceSkill: string | null;
  webhookUrl: string | null;
  serviceConfiguration: { values: ConfigurationValues; missing: string[] };
  hookFailure: HookFailure | null;
  revealed?: RevealedSecret[];
}

export interface TenantServiceView extends ExternalServiceSummary {
  manifest: Omit<ServiceManifest, 'serviceForm'>;
  serviceSkill: string | null;
}

export interface CustomServiceSummary extends ExternalServiceSummary {
  origin: 'custom';
  builderChatId: string;
  published: boolean;
  disabled: boolean;
  hidesBuiltIn: boolean;
}

export interface SdkStatus {
  vendored: string | null;
  latest: string;
  status: 'current' | 'upgrade-available' | 'needs-upgrade' | 'unknown';
}

export interface DefaultEnvironment {
  environmentId: string;
  name: string;
}

export interface CustomServiceView extends OperatorServiceView {
  origin: 'custom';
  builderChatId: string;
  published: true;
  disabled: boolean;
  sdkVersion: string | null;
  sdk: SdkStatus;
  defaultEnvironment: DefaultEnvironment | null;
  hidesBuiltIn: boolean;
}

export interface UncallableCustomServiceView extends ExternalServiceSummary {
  origin: 'custom';
  builderChatId: string;
  published: boolean;
  disabled: boolean;
  hidesBuiltIn: boolean;
  sdk: SdkStatus;
  defaultEnvironment: DefaultEnvironment | null;
  manifest: ServiceManifest | null;
  serviceSkill: string | null;
}

export type TenantServiceEntry = TenantServiceView | CustomServiceSummary;

export interface NewCustomService {
  name: string;
  slug: string;
}

export const SERVICE_SLUG_MAX_LENGTH = 31;
export const SERVICE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
export const RESERVED_SERVICE_SLUGS: readonly string[] = ['usage', 'webhooks', 'agent', 'admin', 'services'];

export function isCustomServiceSummary(entry: ExternalServiceSummary): entry is CustomServiceSummary {
  return 'builderChatId' in entry;
}

export type TenantServicePageView = TenantServiceView | CustomServiceView | UncallableCustomServiceView;

export function isCustomServiceView(view: TenantServicePageView): view is CustomServiceView {
  return 'builderChatId' in view && 'serviceConfiguration' in view;
}

export function isUncallableCustomServiceView(view: TenantServicePageView): view is UncallableCustomServiceView {
  return 'builderChatId' in view && !('serviceConfiguration' in view);
}

export interface ConfigurationIssue {
  pointer: string;
  message: string;
}

export const externalServiceViewKeys = {
  all: ['external-service-views'] as const,
  operatorList: () => [...externalServiceViewKeys.all, 'platform'] as const,
  operatorView: (id: string) => [...externalServiceViewKeys.all, 'platform', id] as const,
  tenantList: () => [...externalServiceViewKeys.all, 'tenant'] as const,
  tenantView: (id: string) => [...externalServiceViewKeys.all, 'tenant', id] as const,
  consumers: (id: string) => [...externalServiceViewKeys.all, 'tenant', id, 'consumers'] as const,
  developmentView: (id: string) => [...externalServiceViewKeys.all, 'development', id] as const,
};

export function callServiceForm(
  service: { id: string; origin: ExternalServiceOrigin },
  route: 'options' | 'info' | 'buttons',
  name: string,
  body: { values: ConfigurationValues; query?: string; item?: string }
): Promise<unknown> {
  return api.post<unknown>(`${serviceBase(service.origin)}/${service.id}/${route}/${encodeURIComponent(name)}`, body);
}

export function useOperatorServices(enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: externalServiceViewKeys.operatorList(),
    queryFn: () => api.get<OperatorServiceSummary[]>(PLATFORM_SERVICES),
    enabled: enabled(),
  }));
}

export function useTenantServices(enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: externalServiceViewKeys.tenantList(),
    queryFn: () => api.get<TenantServiceEntry[]>(TENANT_SERVICES),
    enabled: enabled(),
  }));
}

export function useOperatorService(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: externalServiceViewKeys.operatorView(id()),
    queryFn: () => api.get<OperatorServiceView>(`${PLATFORM_SERVICES}/${id()}`),
    enabled: enabled(),
    reconcile: false,
  }));
}

export function useTenantService(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: externalServiceViewKeys.tenantView(id()),
    queryFn: () => api.get<TenantServicePageView>(`${TENANT_SERVICES}/${id()}`),
    enabled: enabled(),
    reconcile: false,
    retry: false,
  }));
}

export function useSaveServiceConfiguration(id: () => string, origin: () => ExternalServiceOrigin) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (values: ConfigurationValues) =>
      api.put<OperatorServiceView>(`${serviceBase(origin())}/${id()}/configuration`, { values }),
    onSuccess: (view: OperatorServiceView) => {
      qc.setQueryData(
        view.origin === 'custom'
          ? externalServiceViewKeys.tenantView(view.id)
          : externalServiceViewKeys.operatorView(view.id),
        view
      );
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.operatorList() });
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList() });
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantView(view.id) });
    },
  }));
}

function configurationPath(id: string, origin: ExternalServiceOrigin): string {
  return `${serviceBase(origin)}/${id}/configuration`;
}

function useServiceViewMutation<Input>(request: (input: Input) => Promise<OperatorServiceView>) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: request,
    onSuccess: (view: OperatorServiceView) => {
      qc.setQueryData(
        view.origin === 'custom'
          ? externalServiceViewKeys.tenantView(view.id)
          : externalServiceViewKeys.operatorView(view.id),
        view
      );
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.operatorList() });
    },
  }));
}

export interface ServiceConsumer {
  projectId: string;
  projectTitle: string | null;
  projectEnvironmentId: string;
  environmentName: string | null;
}

export function useServiceConsumers(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: externalServiceViewKeys.consumers(id()),
    queryFn: () => api.get<ServiceConsumer[]>(`${TENANT_SERVICES}/${id()}/consumers`),
    enabled: enabled(),
  }));
}

export function useSwitchCustomService(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (action: 'disable' | 'enable') =>
      api.post<CustomServiceSummary>(`${TENANT_SERVICES}/${id()}/${action}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList() });
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantView(id()) });
    },
  }));
}

export function useRotateServiceConfiguration(id: () => string, origin: () => ExternalServiceOrigin) {
  return useServiceViewMutation((target: RotateTarget) =>
    api.post<OperatorServiceView>(`${configurationPath(id(), origin())}/rotate`, target)
  );
}

export function useRetryServiceConfigurationHook(id: () => string, origin: () => ExternalServiceOrigin) {
  return useServiceViewMutation(() =>
    api.post<OperatorServiceView>(`${configurationPath(id(), origin())}/hook/retry`, {})
  );
}

export function useDiscardServiceConfigurationHook(id: () => string, origin: () => ExternalServiceOrigin) {
  return useServiceViewMutation(() =>
    api.post<OperatorServiceView>(`${configurationPath(id(), origin())}/hook/discard`, {})
  );
}

export function useDeleteCustomService(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (confirmSlug: string) =>
      api.delete<void>(`${TENANT_SERVICES}/${id()}?confirmSlug=${encodeURIComponent(confirmSlug)}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: externalServiceViewKeys.tenantView(id()) });
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList() });
    },
  }));
}

export interface DevelopmentServiceView extends ExternalServiceSummary {
  manifest: ServiceManifest;
  webhookUrl: string | null;
  serviceConfiguration: { values: ConfigurationValues; missing: string[] };
  saved: boolean;
  production: { saved: boolean };
  hookFailure: HookFailure | null;
  revealed?: RevealedSecret[];
}

function developmentPath(id: string): string {
  return `${TENANT_SERVICES}/${id}/development`;
}

export function callDevelopmentServiceForm(
  id: string,
  route: 'options' | 'info' | 'buttons',
  name: string,
  body: { values: ConfigurationValues; query?: string; item?: string }
): Promise<unknown> {
  return api.post<unknown>(`${developmentPath(id)}/${route}/${encodeURIComponent(name)}`, body);
}

export function useDevelopmentService(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: externalServiceViewKeys.developmentView(id()),
    queryFn: () => api.get<DevelopmentServiceView>(developmentPath(id())),
    enabled: enabled(),
    retry: false,
  }));
}

function useDevelopmentMutation<Input>(id: () => string, request: (input: Input) => Promise<DevelopmentServiceView>) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: request,
    onSuccess: (view: DevelopmentServiceView) => {
      qc.setQueryData(externalServiceViewKeys.developmentView(id()), view);
    },
  }));
}

export function useSaveDevelopmentConfiguration(id: () => string) {
  return useDevelopmentMutation(id, (values: ConfigurationValues) =>
    api.put<DevelopmentServiceView>(`${developmentPath(id())}/configuration`, { values })
  );
}

export function useRotateDevelopmentConfiguration(id: () => string) {
  return useDevelopmentMutation(id, (target: RotateTarget) =>
    api.post<DevelopmentServiceView>(`${developmentPath(id())}/configuration/rotate`, target)
  );
}

export function useRetryDevelopmentConfigurationHook(id: () => string) {
  return useDevelopmentMutation(id, (_: undefined) =>
    api.post<DevelopmentServiceView>(`${developmentPath(id())}/configuration/hook/retry`, {})
  );
}

export function useDiscardDevelopmentConfigurationHook(id: () => string) {
  return useDevelopmentMutation(id, (_: undefined) =>
    api.post<DevelopmentServiceView>(`${developmentPath(id())}/configuration/hook/discard`, {})
  );
}

export function useCopyProductionToDevelopment(id: () => string) {
  return useDevelopmentMutation(id, (_: undefined) =>
    api.post<DevelopmentServiceView>(`${developmentPath(id())}/configuration/copy-from-production`, {})
  );
}

export function useCreateCustomService() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (service: NewCustomService) => api.post<CustomServiceSummary>(TENANT_SERVICES, service),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList() });
    },
  }));
}
