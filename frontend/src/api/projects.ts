import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { createEffect, createSignal, onCleanup } from 'solid-js';
import { ApiError, api, type Project, type ProjectState } from './client';
import { environmentKeys } from './environments';
import { detectTimezone } from '~/lib/timezone';
import { isMeaningfulSessionTitle } from '~/lib/session-title';

export const projectKeys = {
  all: ['projects'] as const,
  list: () => [...projectKeys.all, 'list'] as const,
  detail: (id: string) => [...projectKeys.all, id] as const,
};

interface ProjectStatusErrorPayload {
  code: 'not_found' | 'forbidden' | 'internal';
  message?: string;
}

export function useProjectStatus(
  projectId: () => string,
  options?: {
    enabled?: () => boolean;
    onEvent?: () => void;
  }
) {
  const qc = useQueryClient();
  const [data, setData] = createSignal<ProjectState>();
  const [error, setError] = createSignal<unknown>();

  const applyStatus = (status: ProjectState) => {
    const changed = JSON.stringify(data()) !== JSON.stringify(status);
    setData(status);
    setError(undefined);
    if (status.status === 'suspended') {
      fetch(`/api/proxy/${status.id}/ping`).catch(() => {});
    }
    if (changed) {
      qc.invalidateQueries({ queryKey: environmentKeys.forProject(status.id) });
    }
  };

  createEffect(() => {
    const id = projectId();
    const enabled = options?.enabled?.() ?? true;
    if (!enabled) return;

    let closed = false;
    const events = new EventSource(statusEventsUrl(id));

    events.onmessage = (event) => {
      try {
        applyStatus(JSON.parse(event.data) as ProjectState);
      } catch (err) {
        setError(err);
      }
      options?.onEvent?.();
    };

    events.addEventListener('error', (event) => {
      if (closed) return;
      const data = (event as MessageEvent).data;
      if (typeof data === 'string' && data.length > 0) {
        try {
          const payload = JSON.parse(data) as ProjectStatusErrorPayload;
          const status = statusForCode(payload.code);
          setError(new ApiError(status, payload.message ?? `Error: ${status}`));
          closed = true;
          events.close();
          return;
        } catch {}
      }
      setError(new Error('Project status stream disconnected'));
    });

    onCleanup(() => {
      closed = true;
      events.close();
    });
  });

  return {
    get data() {
      return data();
    },
    get error() {
      return error();
    },
  };
}

function statusForCode(code: ProjectStatusErrorPayload['code']): number {
  if (code === 'not_found') return 404;
  if (code === 'forbidden') return 403;
  return 500;
}

function statusEventsUrl(projectId: string): string {
  const params = new URLSearchParams();
  const tenant = localStorage.getItem('tenant');
  if (tenant) params.set('tenant', tenant);
  const query = params.toString();
  return `/api/projects/${projectId}/events${query ? `?${query}` : ''}`;
}

export function useProjects(options?: { enabled?: () => boolean }) {
  return createAppQuery(() => ({
    queryKey: projectKeys.list(),
    queryFn: () => api.get<Project[]>('/projects'),
    enabled: options?.enabled ? options.enabled() : true,
  }));
}

export function useProject(projectId: () => string, options?: { enabled?: () => boolean }) {
  return createAppQuery(() => ({
    queryKey: projectKeys.detail(projectId()),
    queryFn: () => api.get<Project>(`/projects/${projectId()}`),
    enabled: options?.enabled ? options.enabled() : true,
  }));
}

export function useRenameProject() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { id: string; title: string }) =>
      api.patch<Project>(`/projects/${params.id}`, { title: params.title }),
    onMutate: (params) => {
      qc.setQueryData<Project[]>(projectKeys.list(), (prev) =>
        prev?.map((p) => (p.id === params.id ? { ...p, title: params.title } : p))
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  }));
}

export function useSyncProjectTitle() {
  const qc = useQueryClient();
  return (projectId: string, title: string, currentTitle?: string | null) => {
    if (!isMeaningfulSessionTitle(title)) return;
    const cached = qc.getQueryData<Project[]>(projectKeys.list());
    const existing = currentTitle?.trim() || cached?.find((p) => p.id === projectId)?.title?.trim();
    if (existing) return;
    qc.setQueryData<Project[]>(projectKeys.list(), (prev) =>
      prev?.map((p) => (p.id === projectId ? { ...p, title } : p))
    );
    const reconcile = () => qc.invalidateQueries({ queryKey: projectKeys.all });
    api.patch<Project>(`/projects/${projectId}`, { title }).then(reconcile, reconcile);
  };
}

export function useCreateUnassignedProject() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (dto: { title?: string; description?: string; agentId?: string } | void) =>
      api.post<Project>('/projects', {
        timezone: detectTimezone(),
        ...dto,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    },
  }));
}

export interface UpdateAppPayload {
  name?: string;
  description?: string | null;
}

export function useUpdateApp() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { projectId: string; environmentId: string; payload: UpdateAppPayload }) =>
      api.patch<Project>(`/projects/${params.projectId}/app`, {
        ...params.payload,
        environmentId: params.environmentId,
      }),
    onSuccess: (_data, params) => {
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: environmentKeys.forProject(params.projectId) });
    },
  }));
}
