import type { AppUserLinkPurpose } from '../../db/schema';

export const APP_USER_PASSWORD_MIN_LENGTH = 8;

export const APP_USER_LOCK_MINUTES = 15;

export const APP_USER_ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const MAX_APP_USER_ROLES = 50;

export type AppUserStatus = 'active' | 'invited' | 'disabled';

export interface AppUserResponse {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  status: AppUserStatus;
  lockedUntil: Date | null;
  lastSignInAt: Date | null;
  createdAt: Date;
}

export interface CreateAppUserDto {
  email: string;
  name?: string | null;
  roles?: string[];
  password?: string;
}

export interface UpdateAppUserDto {
  email?: string;
  name?: string | null;
  roles?: string[];
  password?: string;
  disabled?: boolean;
}

export interface AppUserRoleResponse {
  id: string;
  name: string;
  description: string | null;
  members: number;
}

export interface AppUserRoleDto {
  name?: string;
  description?: string | null;
}

export type { AppUserLinkPurpose };

export interface CreateAppUserLinkDto {
  purpose: AppUserLinkPurpose;
  environmentId?: string;
  send?: boolean;
}

export interface AppUserLinkResponse {
  url: string;
  expiresAt: Date;
  emailed: boolean;
  emailError?: string;
}

export interface AppUserIdentity {
  id: string;
  projectId: string;
  email: string;
  name: string | null;
  roles: string[];
}

export type SignInResult =
  | { outcome: 'signed-in'; user: AppUserIdentity }
  | { outcome: 'wrong-credentials' | 'locked' | 'disabled' };
