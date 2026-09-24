export const API_BASE = '/api';

export function apiRelative(baseUrl: string): string {
  const path = baseUrl.startsWith('http') ? new URL(baseUrl).pathname : baseUrl;
  return path.startsWith(API_BASE) ? path.slice(API_BASE.length) : path;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The `code` the backend's coded refusals carry, e.g. `model_unknown`, so a caller can place the message. */
    public readonly code: string | null = null,
    /** The rest of the refusal body — `model_unknown` names the failing `part`, `agent_in_use` the `projectCount`. */
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export function parseErrorMessage(text: string, fallback: string): string {
  if (!text) return fallback;
  try {
    const body: { message?: string | string[] } = JSON.parse(text);
    if (Array.isArray(body.message)) return body.message.join(', ');
    if (typeof body.message === 'string' && body.message.length > 0) return body.message;
    return fallback;
  } catch {
    return fallback;
  }
}

export async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '');
  return parseErrorMessage(text, fallback);
}

export function parseApiError(text: string, status: number, fallback: string): ApiError {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const code = typeof body.code === 'string' ? body.code : null;
  return new ApiError(status, parseErrorMessage(text, fallback), code, body);
}

export const TENANT_HEADER = 'x-tenant-name';

export function currentTenant(): string | null {
  return localStorage.getItem('tenant');
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  };
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const tenant = currentTenant();
  if (tenant) {
    headers[TENANT_HEADER] = tenant;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    if (res.status === 401) {
      window.location.reload();
      throw new Error('Unauthorized');
    }
    if (res.status === 403 && window.location.pathname !== '/permission-denied') {
      localStorage.removeItem('tenant');
      window.location.href = '/permission-denied';
      throw new Error('Forbidden');
    }
    const text = await res.text().catch(() => '');
    throw parseApiError(text, res.status, `Error: ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : (undefined as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, options?: Pick<RequestInit, 'signal'>) =>
    request<T>(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export interface Tenant {
  id: string;
  name: string;
  displayName: string;
}

export type ProjectStatus = 'starting' | 'active' | 'suspended' | 'disabled' | 'failed';

export type AgentStatus = 'working' | 'idle';

export type RequestLogMode = 'off' | 'metadata' | 'full';

export type PodClass = 'small' | 'medium' | 'large' | 'custom';

export interface PodResources {
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}

export interface PodClassPreset {
  podClass: 'small' | 'medium' | 'large';
  resources: PodResources;
}

export interface PodClassCatalog {
  presets: PodClassPreset[];
  customBounds: { min: PodResources; max: PodResources };
}

export interface UpdateProjectPodClassDto {
  podClass: PodClass;
  cpuMillicores?: number;
  memoryRequestMib?: number;
  memoryLimitMib?: number;
}

export type ProjectKind = 'skill_builder_chat' | 'agent_builder_chat' | 'test';

export interface Project {
  id: string;
  tenantId: string;
  kind: ProjectKind | null;
  workspaceId: string | null;
  folderId: string | null;
  agentId: string;
  /** Set when an import could not find the Agent the export named; the runtime still runs this slug. */
  importedAgent: string | null;
  title: string | null;
  description: string | null;
  status: ProjectStatus;
  bifrostProjectId: string | null;
  timeoutIdle: number;
  appTimeoutIdle: number;
  timezone: string;
  requestLogMode: RequestLogMode;
  requestLogBodyLimit: number;
  podClass: PodClass;
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
  authMode: ProjectAuthMode;
  hasApp: boolean;
  appName: string | null;
  appDescription: string | null;
  environmentIds: string[];
  agentStatus?: AgentStatus;
  lastActiveAt: string | null;
  createdAt: string;
  disabled: boolean;
}

export const podClassApi = {
  catalog: () => api.get<PodClassCatalog>('/pod-classes'),
  update: (projectId: string, dto: UpdateProjectPodClassDto) =>
    api.put<Project>(`/projects/${projectId}/pod-class`, dto),
};

export interface ProjectState {
  id: string;
  status: ProjectStatus;
  workspaceId: string | null;
  title: string | null;
  app: ProjectAppMeta | null;
}

export interface ProjectAppMeta {
  exists: boolean;
  name: string | null;
  description: string | null;
}

export type ProjectAuthMode = 'public' | 'manual' | 'managed';

export interface ProjectAuthOidcConfig {
  clientId?: string;
  clientSecret?: string;
  discoveryUrl?: string;
  scope?: string;
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

export interface TenantConfig {
  privateWorkspaceEnabled: boolean;
}

export type WorkspaceType = 'private' | 'shared';

export interface Workspace {
  id: string;
  tenantId: string;
  type: WorkspaceType;
  ownerId: string | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  projectCount: number;
}

export interface Folder {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  projectCount: number;
}

export interface Agent {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
}

export interface WorkspacePreferences {
  workspaceOrder: string[];
  updatedAt: string | null;
}

export interface OpenCodeSession {
  id: string;
  parentID?: string;
  title?: string;
  time: { created: number; updated: number };
}

export interface User {
  id: string;
  keycloakId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export const userApi = {
  me: () => api.post<User>('/users/me'),
};

export interface Schedule {
  id: string;
  projectId: string;
  projectEnvironmentId: string;
  tenantId: string;
  name: string;
  cronPattern: string;
  timeZone: string;
  targetPath: string;
  method: string;
  body: unknown;
  headers: unknown;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  projectTitle?: string | null;
  environmentName?: string | null;
  isDefault?: boolean;
}

export interface ScheduleExecution {
  id: string;
  scheduleId: string;
  trigger: string;
  firedAt: string;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface UpdateScheduleDto {
  cronPattern?: string;
  targetPath?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  isActive?: boolean;
}

export interface ScheduleListFilter {
  environmentId?: string;
  projectEnvironmentId?: string;
}

export const scheduleApi = {
  list: (filter?: ScheduleListFilter) => {
    const params = new URLSearchParams();
    if (filter?.environmentId) params.set('environmentId', filter.environmentId);
    if (filter?.projectEnvironmentId) params.set('projectEnvironmentId', filter.projectEnvironmentId);
    const qs = params.toString();
    return api.get<Schedule[]>(qs ? `/schedules?${qs}` : '/schedules');
  },
  update: (projectId: string, scheduleId: string, dto: UpdateScheduleDto) =>
    api.patch<Schedule>(`/projects/${projectId}/schedules/${scheduleId}`, dto),
  remove: (projectId: string, scheduleId: string) => api.delete<void>(`/projects/${projectId}/schedules/${scheduleId}`),
  triggerRun: (projectId: string, scheduleId: string) =>
    api.post<{ success: boolean }>(`/projects/${projectId}/schedules/${scheduleId}/run`),
  getExecutions: (scheduleId: string, projectId: string, limit = 50) =>
    api.get<ScheduleExecution[]>(`/projects/${projectId}/schedules/${scheduleId}/executions?limit=${limit}`),
};

export interface TimeoutDefaults {
  defaultTimeoutIdle: number;
  defaultAppTimeoutIdle: number;
}

export interface BudgetDefaults {
  defaultTenantBudget: number;
  defaultTenantBudgetDuration: string;
  defaultProjectBudget: number;
  defaultProjectBudgetDuration: string;
  defaultChatBudget: number;
  defaultChatBudgetDuration: string;
  defaultBackendBudget: number;
  defaultBackendBudgetDuration: string;
}
