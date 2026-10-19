import { createMutation, useQueryClient } from '@tanstack/solid-query';
import type { Field, ServiceManifest } from '@opsiforce/external-service-sdk/forms';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import { externalServiceViewKeys, TENANT_SERVICES, type ConfigurationValues } from './external-service-views';
import type { PublishJob } from './publish';

const JOB_POLL_MS = 2_000;

export interface NamedEnvironment {
  environmentId: string;
  name: string;
}

export interface ServiceEnvironment extends NamedEnvironment {
  slug: string;
  projectEnvironmentId: string | null;
  published: boolean;
  serviceDefault: boolean;
  deployedCommitSha: string | null;
}

export interface CheckProblem {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface CheckReport {
  ok: boolean;
  problems: CheckProblem[];
  events: { type: string; title: string }[];
}

export type ManifestChange = 'added' | 'changed' | 'removed' | 'unchanged';

export type ChangedAspect = 'title' | 'description';

export interface EventChange {
  type: string;
  change: ManifestChange;
  aspects: ChangedAspect[];
}

export interface ManifestDiff {
  events: EventChange[];
}

export type EnvironmentManifestStatus = 'development' | 'same-as-development' | 'development-differs' | 'unpublished';

export interface EnvironmentManifest extends NamedEnvironment {
  status: EnvironmentManifestStatus;
  serviceDefault: boolean;
  publishedCommitSha: string | null;
  manifest: ServiceManifest | null;
  changes: ManifestDiff | null;
}

export interface FieldRename {
  from: string;
  to: string;
}

export interface ConsumerImpact {
  projectId: string;
  projectTitle: string | null;
  projectEnvironmentId: string;
  environmentName: string | null;
  renamed: FieldRename[];
  needsAttention: string[];
  newDefaults: WrittenDefault[];
}

export interface WrittenDefault {
  key: string;
  label: string;
  value: unknown;
}

export interface ConfigurationImpact {
  configurations: number;
  renamed: (FieldRename & { configurations: number })[];
  needsAttention: { field: string; configurations: number }[];
  newDefaults: (WrittenDefault & { configurations: number })[];
  consumers: ConsumerImpact[];
}

export interface TestReportLine {
  expectation: string;
  result: 'pass' | 'fail' | 'not-checked';
  source: 'unit-test' | 'live-call' | 'event' | 'conversation';
  callIds: string[];
  reason?: string;
}

export type TestReport =
  | { state: 'missing' }
  | { state: 'unreadable'; problems: string[] }
  | {
      state: 'present';
      writtenAt: string;
      commit: string;
      headCommit: string | null;
      changedSince: string[] | null;
      manifestMatches: boolean;
      counts: { pass: number; fail: number; notChecked: number };
      lines: TestReportLine[];
      upstreamCalled: boolean;
      unknownCallIds: string[];
    };

export interface ServiceConfigurationReview {
  fields: Field[];
  missing: string[];
  fromDevelopment: string[];
  newDefaults: WrittenDefault[];
}

export type TestWarningCode = 'no-test-report' | 'changed-since-test' | 'upstream-never-called';

export interface TestWarning {
  code: TestWarningCode;
  message: string;
}

export type FieldAspect = 'type' | 'default' | 'required' | 'options' | 'limits' | 'item fields';

export interface FieldChange {
  key: string;
  label: string;
  change: 'added' | 'removed' | 'renamed' | 'changed';
  from?: string;
  aspects: FieldAspect[];
  default?: unknown;
  itemChanges?: FieldChange[];
}

export interface FormChanges {
  serviceForm: FieldChange[];
  projectForm: FieldChange[];
}

export type FolderDiff =
  | { state: 'present'; base: string | null; diff: string; truncated: boolean }
  | { state: 'unavailable'; reason: string };

export interface PublishReview {
  target: NamedEnvironment & { firstPublish: boolean; becomesDefault: boolean };
  current: NamedEnvironment | null;
  check: CheckReport;
  changes: ManifestDiff | null;
  impact: ConfigurationImpact | null;
  testReport: TestReport;
  serviceConfiguration: ServiceConfigurationReview | null;
  builtOnSdk1: boolean;
  testWarnings: TestWarning[];
  publishNote: string | null;
  formChanges: FormChanges | null;
  codeDiff: FolderDiff;
  skillDiff: FolderDiff;
}

export interface DefaultEnvironmentReview {
  target: NamedEnvironment;
  current: NamedEnvironment | null;
  check: CheckReport;
  impact: ConfigurationImpact | null;
  serviceConfiguration: ServiceConfigurationReview | null;
}

export interface ServiceSubmission {
  environmentId: string;
  values: ConfigurationValues;
  copyFromDevelopment: string[];
}

export const servicePublishingKeys = {
  environments: (id: string) => [...externalServiceViewKeys.all, 'tenant', id, 'environments'] as const,
  manifests: (id: string) => [...externalServiceViewKeys.all, 'tenant', id, 'manifests'] as const,
  publishReview: (id: string, environmentId: string) =>
    [...externalServiceViewKeys.all, 'tenant', id, 'publish', environmentId] as const,
  publishJob: (id: string, environmentId: string) =>
    [...externalServiceViewKeys.all, 'tenant', id, 'publish', environmentId, 'job'] as const,
  defaultEnvironmentReview: (id: string, environmentId: string) =>
    [...externalServiceViewKeys.all, 'tenant', id, 'default-environment', environmentId] as const,
};

function isFinished(job: PublishJob | null | undefined): boolean {
  return job?.status === 'done' || job?.status === 'failed';
}

export function useServiceEnvironments(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: servicePublishingKeys.environments(id()),
    queryFn: () => api.get<ServiceEnvironment[]>(`${TENANT_SERVICES}/${id()}/environments`),
    enabled: enabled(),
    reconcile: 'environmentId',
  }));
}

export function useEnvironmentManifests(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: servicePublishingKeys.manifests(id()),
    queryFn: () => api.get<EnvironmentManifest[]>(`${TENANT_SERVICES}/${id()}/manifests`),
    enabled: enabled(),
    reconcile: false,
  }));
}

export function usePublishReview(id: () => string, environmentId: () => string | null) {
  return createAppQuery(() => ({
    queryKey: servicePublishingKeys.publishReview(id(), environmentId() ?? ''),
    queryFn: () =>
      api.get<PublishReview>(
        `${TENANT_SERVICES}/${id()}/publish?environmentId=${encodeURIComponent(environmentId() ?? '')}`
      ),
    enabled: environmentId() !== null,
    reconcile: false,
    retry: false,
  }));
}

export function usePublishJob(id: () => string, environmentId: () => string | null, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: servicePublishingKeys.publishJob(id(), environmentId() ?? ''),
    queryFn: () =>
      api.get<PublishJob | null>(
        `${TENANT_SERVICES}/${id()}/publish/job?environmentId=${encodeURIComponent(environmentId() ?? '')}`
      ),
    enabled: enabled() && environmentId() !== null,
    reconcile: false,
    refetchInterval: (query: { state: { data?: PublishJob | null } }) =>
      isFinished(query.state.data) ? false : JOB_POLL_MS,
  }));
}

export function usePublishService(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (submission: ServiceSubmission) =>
      api.post<PublishJob>(`${TENANT_SERVICES}/${id()}/publish`, submission),
    onSuccess: (job: PublishJob) => {
      qc.setQueryData(servicePublishingKeys.publishJob(id(), job.environmentId), job);
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantView(id()), exact: true });
    },
  }));
}

export function useDefaultEnvironmentReview(id: () => string, environmentId: () => string | null) {
  return createAppQuery(() => ({
    queryKey: servicePublishingKeys.defaultEnvironmentReview(id(), environmentId() ?? ''),
    queryFn: () =>
      api.get<DefaultEnvironmentReview>(
        `${TENANT_SERVICES}/${id()}/default-environment?environmentId=${encodeURIComponent(environmentId() ?? '')}`
      ),
    enabled: environmentId() !== null,
    reconcile: false,
    retry: false,
  }));
}

export function useSwitchDefaultEnvironment(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (submission: ServiceSubmission) =>
      api.put<NamedEnvironment>(`${TENANT_SERVICES}/${id()}/default-environment`, submission),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantView(id()), exact: true });
      void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList(), exact: true });
      void qc.invalidateQueries({ queryKey: servicePublishingKeys.environments(id()) });
      void qc.invalidateQueries({ queryKey: servicePublishingKeys.manifests(id()) });
    },
  }));
}

export function useRefreshAfterPublish(id: () => string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantView(id()), exact: true });
    void qc.invalidateQueries({ queryKey: externalServiceViewKeys.tenantList(), exact: true });
    void qc.invalidateQueries({ queryKey: servicePublishingKeys.environments(id()) });
    void qc.invalidateQueries({ queryKey: servicePublishingKeys.manifests(id()) });
  };
}
