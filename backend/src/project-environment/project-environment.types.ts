import type { ProjectAuthMode, ProjectStatus, RequestLogMode } from '../project/project.types';
import { projectEnvironments } from '../../db/schema';

export type ProjectEnvironmentRow = typeof projectEnvironments.$inferSelect;

export interface ProjectEnvironmentContext {
  id: string;
  shortId: string;
  projectId: string;
  environmentId: string | null;
  isDefault: boolean;
  directory: string;
  status: ProjectStatus;
  podIp: string | null;
  sessionId: string | null;
  platformVersion: string;
  authMode: ProjectAuthMode;
  deployedCommitSha: string | null;
  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tenantId: string | null;
  workspaceId: string | null;
  agentId: string;
  title: string | null;
  description: string | null;
  disabled: boolean;
  bifrostProjectId: string | null;
  timeoutIdle: number;
  appTimeoutIdle: number;
  timezone: string;
  requestLogMode: RequestLogMode;
  requestLogBodyLimit: number;
  environmentName: string | null;
  environmentSlug: string | null;
  environmentIsDefault: boolean;
  hasApp: boolean;
  appSlug: string | null;
  servesAnExternalService: boolean;
}

export interface CreateProjectEnvironmentInput {
  id: string;
  projectId: string;
  environmentId: string | null;
  isDefault: boolean;
  directory: string;
  platformVersion: string;
  status?: ProjectStatus;
  authMode?: ProjectAuthMode;
  deployedCommitSha?: string | null;
}

export interface ProjectEnvironmentPatch {
  status?: ProjectStatus;
  podIp?: string | null;
  sessionId?: string | null;
  platformVersion?: string;
  authMode?: ProjectAuthMode;
  deployedCommitSha?: string | null;
  environmentId?: string | null;
  lastActiveAt?: Date | null;
}
