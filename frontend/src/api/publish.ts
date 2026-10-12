import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { api } from './client';
import { projectKeys } from './projects';
import { environmentKeys, type ProjectEnvironmentStatus } from './environments';

export type PublishJobStatus = 'queued' | 'committing' | 'building' | 'migrating' | 'swapping' | 'done' | 'failed';

export interface PublishTarget {
  environmentId: string;
  name: string;
  slug: string;
  description: string | null;
  projectEnvironmentId: string | null;
  status: ProjectEnvironmentStatus | null;
  deployedCommitSha: string | null;
}

export interface PublishFormVariable {
  key: string;
  value: string;
  devValue: string;
  isNew: boolean;
}

export interface PublishFormSchedule {
  id: string;
  name: string;
  selected: boolean;
}

export interface PublishForm {
  environmentId: string;
  environmentName: string;
  isFirstPublish: boolean;
  variables: PublishFormVariable[];
  schedules: PublishFormSchedule[];
}

export interface PublishDto {
  environmentId: string;
  variables: Record<string, string>;
  scheduleIds: string[];
}

export type PublishReportLine =
  | {
      kind: 'project-configuration';
      service: string;
      displayName: string;
      outcome: 'carried';
      receiveTurnedOff: string[];
    }
  | { kind: 'project-configuration'; service: string; displayName: string; outcome: 'failed'; code: string }
  | { kind: 'skills-off'; switchedOff: string[]; switchedOn: string[] };

export interface PublishJob {
  id: string;
  projectEnvironmentId: string;
  environmentId: string;
  status: PublishJobStatus;
  commitSha: string | null;
  error: string | null;
  report: PublishReportLine[];
  createdAt: string;
  updatedAt: string;
}

export function publishEventsUrl(projectId: string, environmentId: string): string {
  const tenant = localStorage.getItem('tenant');
  const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
  return `/api/projects/${projectId}/publish/environments/${environmentId}/job/stream${query}`;
}

export const publishKeys = {
  targets: (projectId: string) => [...projectKeys.detail(projectId), 'publish', 'targets'] as const,
  form: (projectId: string, environmentId: string) =>
    [...projectKeys.detail(projectId), 'publish', 'form', environmentId] as const,
};

export function usePublishTargets(projectId: () => string, options?: { enabled?: () => boolean }) {
  return createAppQuery(() => ({
    queryKey: publishKeys.targets(projectId()),
    queryFn: () => api.get<PublishTarget[]>(`/projects/${projectId()}/publish/targets`),
    enabled: options?.enabled ? options.enabled() : true,
  }));
}

export function usePublishForm(
  projectId: () => string,
  environmentId: () => string | null,
  options?: { enabled?: () => boolean }
) {
  return createAppQuery(() => ({
    queryKey: publishKeys.form(projectId(), environmentId() ?? ''),
    queryFn: () => api.get<PublishForm>(`/projects/${projectId()}/publish/form?environmentId=${environmentId()}`),
    enabled: (options?.enabled ? options.enabled() : true) && !!environmentId(),
  }));
}

export function usePublish() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { projectId: string; dto: PublishDto }) =>
      api.post<PublishJob>(`/projects/${params.projectId}/publish`, params.dto),
    onSuccess: (_job, vars) => {
      qc.invalidateQueries({ queryKey: publishKeys.targets(vars.projectId) });
      qc.invalidateQueries({ queryKey: environmentKeys.forProject(vars.projectId) });
    },
  }));
}

export function usePublishJob(
  projectId: () => string,
  environmentId: () => string | null,
  options?: { enabled?: () => boolean }
) {
  const qc = useQueryClient();
  const [data, setData] = createSignal<PublishJob | null>(null);

  createEffect(() => {
    const enabled = (options?.enabled ? options.enabled() : true) && !!environmentId();
    const envId = environmentId();
    const pid = projectId();
    if (!enabled || !envId) {
      setData(null);
      return;
    }

    const tenant = localStorage.getItem('tenant');
    const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
    const source = new EventSource(`/api/projects/${pid}/publish/environments/${envId}/job/stream${query}`);

    source.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data) as PublishJob;
        setData(job);
        if (job.status === 'done' || job.status === 'failed') {
          qc.invalidateQueries({ queryKey: environmentKeys.forProject(pid) });
          qc.invalidateQueries({ queryKey: publishKeys.targets(pid) });
          qc.invalidateQueries({ queryKey: projectKeys.all });
          source.close();
        }
      } catch {
        // ignore malformed frames
      }
    };

    onCleanup(() => source.close());
  });

  return {
    get data() {
      return data();
    },
  };
}
