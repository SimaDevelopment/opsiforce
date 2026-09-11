import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';
import { projectKeys } from './projects';

export type ProjectEnvironmentStatus =
  | 'starting'
  | 'active'
  | 'suspended'
  | 'disabled'
  | 'failed'
  | 'pending'
  | 'claiming'
  | 'publishing';

export interface Environment {
  id: string;
  name: string;
  slug: string;
  shortName: string | null;
  description: string | null;
  color: string;
  isDefault: boolean;
  isProtected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectEnvironment {
  id: string;
  projectId: string;
  environmentId: string;
  name: string;
  slug: string | null;
  isDefault: boolean;
  status: ProjectEnvironmentStatus;
  authMode: string;
  deployedCommitSha: string | null;
  lastActiveAt: string | null;
  hasApp: boolean;
  appName: string | null;
  appDescription: string | null;
  sessionId: string | null;
}

export interface CreateEnvironmentDto {
  name: string;
  slug: string;
  shortName?: string | null;
  description?: string;
  color?: string;
}

export interface UpdateEnvironmentDto {
  name?: string;
  shortName?: string | null;
  description?: string;
  color?: string;
}

export const environmentKeys = {
  all: ['environments'] as const,
  registry: () => [...environmentKeys.all, 'registry'] as const,
  forProject: (projectId: string) => [...projectKeys.detail(projectId), 'environments'] as const,
};

export function useEnvironments(options?: { enabled?: () => boolean }) {
  return createAppQuery(() => ({
    queryKey: environmentKeys.registry(),
    queryFn: () => api.get<Environment[]>('/environments'),
    enabled: options?.enabled ? options.enabled() : true,
  }));
}

export function useCreateEnvironment() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (dto: CreateEnvironmentDto) => api.post<Environment>('/environments', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: environmentKeys.all }),
  }));
}

export function useUpdateEnvironment() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { id: string; dto: UpdateEnvironmentDto }) =>
      api.patch<Environment>(`/environments/${params.id}`, params.dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: environmentKeys.all }),
  }));
}

export function useDeleteEnvironment() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/environments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: environmentKeys.all }),
  }));
}

export function useProjectEnvironments(projectId: () => string, options?: { enabled?: () => boolean }) {
  return createAppQuery(() => ({
    queryKey: environmentKeys.forProject(projectId()),
    queryFn: () => api.get<ProjectEnvironment[]>(`/projects/${projectId()}/environments`),
    enabled: options?.enabled ? options.enabled() : true,
  }));
}

export interface OpencodeConnection {
  environmentId: string;
  baseUrl: string;
  openapiUrl: string;
  sessionId: string;
  build: string | null;
}

export function useConnectEnvironment() {
  const qc = useQueryClient();
  return async (projectId: string, environmentId: string, signal?: AbortSignal): Promise<OpencodeConnection> => {
    const connection = await api.post<OpencodeConnection>(
      `/projects/${projectId}/environments/${environmentId}/connect`,
      undefined,
      { signal }
    );
    signal?.throwIfAborted();
    qc.setQueryData<ProjectEnvironment[]>(environmentKeys.forProject(projectId), (prev) =>
      prev?.map((e) => (e.id === environmentId ? { ...e, sessionId: connection.sessionId } : e))
    );
    return connection;
  };
}

export function useRestartProjectEnvironment() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { projectId: string; environmentId: string }) =>
      api.post<void>(`/projects/${params.projectId}/environments/${params.environmentId}/restart`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: environmentKeys.forProject(vars.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  }));
}

export function useDeleteProjectEnvironment() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { projectId: string; environmentId: string }) =>
      api.delete<{ ok: true }>(`/projects/${params.projectId}/environments/${params.environmentId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: environmentKeys.forProject(vars.projectId) });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  }));
}
