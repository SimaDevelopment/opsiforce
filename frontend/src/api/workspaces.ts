import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { toast } from 'solid-sonner';
import { ApiError, api, type Folder, type Project, type User, type Workspace } from './client';
import { detectTimezone } from '~/lib/timezone';

export const workspaceKeys = {
  all: ['workspaces'] as const,
  list: (scope: 'member' | 'all' = 'member') => [...workspaceKeys.all, 'list', scope] as const,
  detail: (id: string) => [...workspaceKeys.all, id] as const,
  members: (id: string) => [...workspaceKeys.all, id, 'members'] as const,
  projects: (id: string) => [...workspaceKeys.all, id, 'projects'] as const,
  folders: (id: string) => [...workspaceKeys.all, id, 'folders'] as const,
};

type QueryClient = ReturnType<typeof useQueryClient>;

function invalidateProjectPlacement(qc: QueryClient, workspaceId: string) {
  qc.invalidateQueries({ queryKey: ['projects'] });
  qc.invalidateQueries({ queryKey: workspaceKeys.projects(workspaceId) });
  qc.invalidateQueries({ queryKey: workspaceKeys.folders(workspaceId) });
}

export function useWorkspaces(scope: 'member' | 'all' = 'member') {
  return createAppQuery(() => ({
    queryKey: workspaceKeys.list(scope),
    queryFn: () => api.get<Workspace[]>(scope === 'all' ? '/workspaces?scope=all' : '/workspaces'),
  }));
}

export function useWorkspace(workspaceId: () => string | null) {
  return createAppQuery(() => ({
    queryKey: workspaceKeys.detail(workspaceId() ?? ''),
    queryFn: () => api.get<Workspace>(`/workspaces/${workspaceId()}`),
    enabled: !!workspaceId(),
  }));
}

export function useWorkspaceMembers(workspaceId: () => string | null) {
  return createAppQuery(() => ({
    queryKey: workspaceKeys.members(workspaceId() ?? ''),
    queryFn: () => api.get<User[]>(`/workspaces/${workspaceId()}/members`),
    enabled: !!workspaceId(),
  }));
}

export function useWorkspaceProjects(workspaceId: () => string | null) {
  return createAppQuery(() => ({
    queryKey: workspaceKeys.projects(workspaceId() ?? ''),
    queryFn: () => api.get<Project[]>(`/workspaces/${workspaceId()}/projects`),
    enabled: !!workspaceId(),
  }));
}

export function useWorkspaceFolders(workspaceId: () => string) {
  return createAppQuery(() => ({
    queryKey: workspaceKeys.folders(workspaceId()),
    queryFn: () => api.get<Folder[]>(`/workspaces/${workspaceId()}/folders`),
    // a Public project or a Builder chat has no workspace, and a project that
    // is still loading has none yet; neither should ask for /workspaces//folders
    enabled: workspaceId() !== '',
  }));
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { workspaceId: string; name: string }) =>
      api.post<Folder>(`/workspaces/${params.workspaceId}/folders`, { name: params.name }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: workspaceKeys.folders(vars.workspaceId) }),
  }));
}

export function useRenameFolder() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { workspaceId: string; folderId: string; name: string }) =>
      api.patch<Folder>(`/workspaces/${params.workspaceId}/folders/${params.folderId}`, { name: params.name }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: workspaceKeys.folders(vars.workspaceId) }),
  }));
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { workspaceId: string; folderId: string }) =>
      api.delete<void>(`/workspaces/${params.workspaceId}/folders/${params.folderId}`),
    onSuccess: (_data, vars) => invalidateProjectPlacement(qc, vars.workspaceId),
  }));
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (dto: { name: string; description?: string | null }) => api.post<Workspace>('/workspaces', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  }));
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { id: string; dto: { name?: string; description?: string | null } }) =>
      api.patch<Workspace>(`/workspaces/${params.id}`, params.dto),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
      qc.invalidateQueries({ queryKey: workspaceKeys.detail(vars.id) });
    },
  }));
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.delete<void>(`/workspaces/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  }));
}

export function useAddWorkspaceMember() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { workspaceId: string; userId: string }) =>
      api.post<void>(`/workspaces/${params.workspaceId}/members`, { userId: params.userId }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: workspaceKeys.members(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.detail(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  }));
}

export function useRemoveWorkspaceMember() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { workspaceId: string; userId: string }) =>
      api.delete<void>(`/workspaces/${params.workspaceId}/members/${params.userId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: workspaceKeys.members(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.detail(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  }));
}

export function useCreateProjectInWorkspace() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: {
      workspaceId: string;
      folderId?: string | null;
      dto?: { title?: string; description?: string; agentId?: string; timezone?: string };
    }) =>
      api.post<Project>(`/workspaces/${params.workspaceId}/projects`, {
        timezone: detectTimezone(),
        folderId: params.folderId ?? null,
        ...params.dto,
      }),
    onSuccess: (_data, vars) => {
      invalidateProjectPlacement(qc, vars.workspaceId);
      qc.invalidateQueries({ queryKey: workspaceKeys.detail(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
    },
  }));
}

function assignProjectRequest(workspaceId: string, projectId: string, folderId: string | null) {
  return api.post<Project>(`/workspaces/${workspaceId}/projects/${projectId}`, { folderId });
}

export function useMoveProjectToFolder() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: { workspaceId: string; projectId: string; folderId: string | null }) =>
      assignProjectRequest(params.workspaceId, params.projectId, params.folderId),
    onSuccess: (_data, vars) => {
      toast.success(vars.folderId ? 'Project moved into folder' : 'Project moved to workspace root');
      invalidateProjectPlacement(qc, vars.workspaceId);
    },
    onError: () => toast.error('Failed to move project'),
  }));
}

/**
 * Move a project to a target workspace (or null to unassign). Idempotent.
 * Callers pass `fromName` / `toName` so the success toast can read
 * "Project moved from X to Y" without a second lookup.
 */
export interface MoveProjectVars {
  projectId: string;
  fromWorkspaceId: string | null;
  toWorkspaceId: string | null;
  toFolderId?: string | null;
  fromName: string;
  toName: string;
}

export function useMoveProject() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: async (params: MoveProjectVars) => {
      if (params.toWorkspaceId === null) {
        const fromId = params.fromWorkspaceId;
        if (fromId === null) return;
        return api.delete<Project>(`/workspaces/${fromId}/projects/${params.projectId}`);
      }
      return assignProjectRequest(params.toWorkspaceId, params.projectId, params.toFolderId ?? null);
    },
    onSuccess: (_data, vars) => {
      toast.success(`Project moved from ${vars.fromName} to ${vars.toName}`);
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
      if (vars.fromWorkspaceId) {
        qc.invalidateQueries({ queryKey: workspaceKeys.projects(vars.fromWorkspaceId) });
        qc.invalidateQueries({ queryKey: workspaceKeys.detail(vars.fromWorkspaceId) });
        qc.invalidateQueries({ queryKey: workspaceKeys.folders(vars.fromWorkspaceId) });
      }
      if (vars.toWorkspaceId) {
        qc.invalidateQueries({ queryKey: workspaceKeys.projects(vars.toWorkspaceId) });
        qc.invalidateQueries({ queryKey: workspaceKeys.detail(vars.toWorkspaceId) });
        qc.invalidateQueries({ queryKey: workspaceKeys.folders(vars.toWorkspaceId) });
      }
    },
    onError: () => toast.error('Failed to move project'),
  }));
}

function invalidateWorkspaceMove(qc: QueryClient, fromWorkspaceId: string, toWorkspaceId: string) {
  qc.invalidateQueries({ queryKey: ['projects'] });
  qc.invalidateQueries({ queryKey: workspaceKeys.all });
  for (const id of [fromWorkspaceId, toWorkspaceId]) {
    qc.invalidateQueries({ queryKey: workspaceKeys.projects(id) });
    qc.invalidateQueries({ queryKey: workspaceKeys.detail(id) });
    qc.invalidateQueries({ queryKey: workspaceKeys.folders(id) });
  }
}

export interface MoveFolderVars {
  folderId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  fromName: string;
  toName: string;
}

export function useMoveFolder() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (params: MoveFolderVars) =>
      api.post<Folder>(`/workspaces/${params.fromWorkspaceId}/folders/${params.folderId}/move`, {
        toWorkspaceId: params.toWorkspaceId,
      }),
    onSuccess: (_data, vars) => {
      toast.success(`Folder moved from ${vars.fromName} to ${vars.toName}`);
      invalidateWorkspaceMove(qc, vars.fromWorkspaceId, vars.toWorkspaceId);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Failed to move folder'),
  }));
}

export const PUBLIC_LABEL = 'Public';
