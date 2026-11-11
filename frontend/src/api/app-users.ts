import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api } from './client';

export type AppUserStatus = 'active' | 'invited' | 'disabled';

export interface AppUser {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  status: AppUserStatus;
  lockedUntil: string | null;
  lastSignInAt: string | null;
  createdAt: string;
}

export interface AppUserRole {
  id: string;
  name: string;
  description: string | null;
  members: number;
}

export interface AppUsersOverview {
  users: AppUser[];
  roles: AppUserRole[];
  email: boolean;
}

export interface CreateAppUserDto {
  email: string;
  name?: string | null;
  roles: string[];
  password?: string;
}

export interface UpdateAppUserDto {
  email?: string;
  name?: string | null;
  roles?: string[];
  password?: string;
  disabled?: boolean;
}

export interface AppUserRoleDto {
  name?: string;
  description?: string | null;
}

export type AppUserLinkPurpose = 'invite' | 'reset';

export interface AppUserLink {
  url: string;
  expiresAt: string;
  emailed: boolean;
  emailError?: string;
}

export const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const appUserKeys = {
  overview: (projectId: string) => ['project', projectId, 'app-users'] as const,
};

const projectPath = (projectId: string) => `/projects/${projectId}`;

export function useAppUsers(projectId: () => string, enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: appUserKeys.overview(projectId()),
    queryFn: () => api.get<AppUsersOverview>(`${projectPath(projectId())}/app-users`),
    enabled: enabled(),
  }));
}

function useOverviewMutation<TVariables, TResult>(
  projectId: () => string,
  run: (path: string, variables: TVariables) => Promise<TResult>
) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (variables: TVariables) => run(projectPath(projectId()), variables),
    onSuccess: () => qc.invalidateQueries({ queryKey: appUserKeys.overview(projectId()) }),
  }));
}

export const useCreateAppUser = (projectId: () => string) =>
  useOverviewMutation(projectId, (path, dto: CreateAppUserDto) => api.post<AppUser>(`${path}/app-users`, dto));

export const useUpdateAppUser = (projectId: () => string) =>
  useOverviewMutation(projectId, (path, { id, dto }: { id: string; dto: UpdateAppUserDto }) =>
    api.patch<AppUser>(`${path}/app-users/${id}`, dto)
  );

export const useDeleteAppUser = (projectId: () => string) =>
  useOverviewMutation(projectId, (path, id: string) => api.delete<void>(`${path}/app-users/${id}`));

export const useCreateAppUserLink = (projectId: () => string) =>
  useOverviewMutation(
    projectId,
    (
      path,
      {
        id,
        purpose,
        environmentId,
        send,
      }: { id: string; purpose: AppUserLinkPurpose; environmentId?: string; send?: boolean }
    ) => api.post<AppUserLink>(`${path}/app-users/${id}/links`, { purpose, environmentId, send })
  );

export const useCreateAppUserRole = (projectId: () => string) =>
  useOverviewMutation(projectId, (path, dto: AppUserRoleDto) => api.post<AppUserRole>(`${path}/app-user-roles`, dto));

export const useUpdateAppUserRole = (projectId: () => string) =>
  useOverviewMutation(projectId, (path, { id, dto }: { id: string; dto: AppUserRoleDto }) =>
    api.patch<AppUserRole>(`${path}/app-user-roles/${id}`, dto)
  );

export const useDeleteAppUserRole = (projectId: () => string) =>
  useOverviewMutation(projectId, (path, id: string) => api.delete<void>(`${path}/app-user-roles/${id}`));

export function displayStatus(user: AppUser, now: number): AppUserStatus | 'locked' {
  return user.status === 'active' && user.lockedUntil && new Date(user.lockedUntil).getTime() > now
    ? 'locked'
    : user.status;
}
