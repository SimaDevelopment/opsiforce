import type { ProjectKindValue } from '../../db/schema';
import type { PodClass } from '../pod/pod-classes';

export const ProjectStatus = {
  Starting: 'starting',
  Active: 'active',
  Suspended: 'suspended',
  Disabled: 'disabled',
  Failed: 'failed',
  Pending: 'pending',
  Claiming: 'claiming',
  Publishing: 'publishing',
} as const;

export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const AgentStatus = {
  Working: 'working',
  Idle: 'idle',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const RequestLogMode = {
  Off: 'off',
  Metadata: 'metadata',
  Full: 'full',
} as const;

export type RequestLogMode = (typeof RequestLogMode)[keyof typeof RequestLogMode];

export const REQUEST_LOG_BODY_LIMIT_MAX = 3 * 1024 * 1024;

/** Where a new Project belongs and who made it — the facts `CreateProjectDto` does not carry. */
export interface ProjectCreationContext {
  workspaceId?: string | null;
  folderId?: string | null;
  createdBy?: string | null;
  createdByProjectId?: string | null;
  kind?: ProjectKind | null;
}

export interface CreateProjectDto {
  title?: string;
  description?: string;
  timezone?: string;
  agentId?: string;
}

export interface UpdateProjectDto {
  title?: string;
  description?: string;
  timeoutIdle?: number;
  appTimeoutIdle?: number;
  timezone?: string;
}

export interface DuplicateProjectDto {
  title?: string;
}

export interface UpdateProjectLoggingDto {
  mode: RequestLogMode;
  bodyLimit?: number;
}

export interface ProjectLoggingResponse {
  mode: RequestLogMode;
  bodyLimit: number;
}

export interface UpdateProjectPodClassDto {
  podClass: PodClass;
  cpuMillicores?: number;
  memoryRequestMib?: number;
  memoryLimitMib?: number;
}

export type ProjectKind = ProjectKindValue;

export const PROJECT_KINDS = [
  'skill_builder_chat',
  'agent_builder_chat',
  'test',
] as const satisfies readonly ProjectKind[];

export const CHAT_KINDS = ['skill_builder_chat', 'agent_builder_chat'] as const satisfies readonly ProjectKind[];

export type ChatKind = (typeof CHAT_KINDS)[number];

export const TEST_PROJECT_KIND = 'test' satisfies ProjectKind;

export function isChatKind(kind: ProjectKind | null | undefined): kind is ChatKind {
  return kind !== null && kind !== undefined && (CHAT_KINDS as readonly string[]).includes(kind);
}

export interface ProjectResponse {
  id: string;
  tenantId: string | null;
  workspaceId: string | null;
  folderId: string | null;
  agentId: string;
  title: string | null;
  description: string | null;
  disabled: boolean;
  bifrostProjectId: string | null;
  createdBy: string | null;
  createdByProjectId: string | null;
  kind: ProjectKind | null;
  importedAgent: string | null;
  directory: string;
  status: ProjectStatus;
  podIp: string | null;
  authMode: ProjectAuthMode;
  timeoutIdle: number;
  appTimeoutIdle: number;
  timezone: string;
  requestLogMode: RequestLogMode;
  requestLogBodyLimit: number;
  podClass: PodClass;
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
  hasApp: boolean;
  appName: string | null;
  appDescription: string | null;
  environmentIds: string[];
  agentStatus?: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectState {
  id: string;
  status: ProjectStatus;
  workspaceId: string | null;
  title: string | null;
  app: ProjectAppMeta | null;
}

export interface ProjectEnvironmentSummary {
  id: string;
  projectId: string;
  environmentId: string | null;
  name: string;
  slug: string | null;
  isDefault: boolean;
  status: ProjectStatus;
  authMode: ProjectAuthMode;
  deployedCommitSha: string | null;
  lastActiveAt: Date | null;
  hasApp: boolean;
  appName: string | null;
  appDescription: string | null;
  sessionId: string | null;
}

export interface ProjectAppMeta {
  exists: boolean;
  name: string | null;
  description: string | null;
}

export interface ProjectAuthOidcConfig {
  clientId?: string;
  clientSecret?: string;
  discoveryUrl?: string;
  scope?: string;
}

export type ProjectAuthMode = 'public' | 'manual' | 'managed';

export interface ManagedAuthConfig {
  managedOidcClientSecret?: string;
  managedOidcIssuerUrl?: string;
}

export function availableAuthModes(config: ManagedAuthConfig): ProjectAuthMode[] {
  const modes: ProjectAuthMode[] = ['public', 'manual'];
  if (config.managedOidcClientSecret?.trim() && config.managedOidcIssuerUrl?.trim()) {
    modes.push('managed');
  }
  return modes;
}

export interface ProjectAuthResponse {
  mode: ProjectAuthMode;
  config?: ProjectAuthOidcConfig;
  bypassAuthPaths?: string[];
  callbackUrls: string[];
}

export interface UpdateProjectAuthDto {
  mode: ProjectAuthMode;
  config?: ProjectAuthOidcConfig;
  bypassAuthPaths?: string[];
}

export interface UpdateAppDto {
  name?: string;
  description?: string | null;
  environmentId?: string;
}
