import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api, currentTenant, parseApiError, TENANT_HEADER } from './client';
import type { StoreFilter } from './store';

export interface SkillFlags {
  has_executables: boolean;
}

export interface SkillVersionSummary {
  version: number;
  description: string | null;
  flags: SkillFlags;
}

export interface SkillVersion {
  version: number;
  description: string | null;
  flags: SkillFlags;
  lints: string[];
  contentHash: string;
  createdVia: string;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: string;
  isLatest: boolean;
}

export interface SkillFile {
  path: string;
  /** Base64 when `isBinary`, UTF-8 text otherwise. */
  content: string;
  isBinary: boolean;
  isExecutable: boolean;
  size: number;
}

export interface SkillAgentUsage {
  id: string;
  name: string;
  displayName: string | null;
  /** Every version this agent pins, one per Environment it carries the skill in. */
  pinnedVersions: number[];
  outdated: boolean;
  omittedIn: number;
}

export interface Skill {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  origin: string;
  visibility: string;
  archived: boolean;
  available: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdInChatProjectId: string | null;
  usedByAgentCount: number;
  outdatedAgentCount: number;
  latestVersion: SkillVersionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export const skillKeys = {
  all: ['skills'] as const,
  list: (filter: StoreFilter, query: string) => [...skillKeys.all, 'list', filter, query] as const,
  detail: (id: string) => [...skillKeys.all, 'detail', id] as const,
  versions: (id: string) => [...skillKeys.all, 'versions', id] as const,
  files: (id: string, version: number) => [...skillKeys.all, 'files', id, version] as const,
  agents: (id: string) => [...skillKeys.all, 'agents', id] as const,
};

function listPath(filter: StoreFilter, query: string): string {
  const params = new URLSearchParams({ filter });
  if (query) params.set('q', query);
  return `/skills?${params.toString()}`;
}

export function useSkills(filter: () => StoreFilter, query: () => string) {
  return createAppQuery(() => ({
    queryKey: skillKeys.list(filter(), query()),
    queryFn: () => api.get<Skill[]>(listPath(filter(), query())),
    placeholderData: (previous: Skill[] | undefined) => previous,
  }));
}

export function useSkill(id: () => string) {
  return createAppQuery(() => ({
    queryKey: skillKeys.detail(id()),
    queryFn: () => api.get<Skill>(`/skills/${id()}`),
  }));
}

export function useSkillVersions(id: () => string) {
  return createAppQuery(() => ({
    queryKey: skillKeys.versions(id()),
    queryFn: () => api.get<SkillVersion[]>(`/skills/${id()}/versions`),
    reconcile: 'version' as const,
  }));
}

/** `version` is 0 until the version list has loaded, which keeps the query parked. */
export function useSkillFiles(id: () => string, version: () => number) {
  return createAppQuery(() => ({
    queryKey: skillKeys.files(id(), version()),
    queryFn: () => api.get<SkillFile[]>(`/skills/${id()}/versions/${version()}/files`),
    enabled: version() > 0,
    reconcile: 'path' as const,
  }));
}

export function useSkillAgents(id: () => string) {
  return createAppQuery(() => ({
    queryKey: skillKeys.agents(id()),
    queryFn: () => api.get<SkillAgentUsage[]>(`/skills/${id()}/agents`),
  }));
}

export function skillExportUrl(id: string, version: number): string {
  const tenant = currentTenant();
  const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : '';
  return `/api/skills/${id}/versions/${version}/export${query}`;
}

function useSkillMutation<TVariables>(call: (variables: TVariables) => Promise<Skill>) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: call,
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  }));
}

export function useDuplicateSkill(id: () => string) {
  return useSkillMutation((dto: { name: string }) => api.post<Skill>(`/skills/${id()}/duplicate`, dto));
}

export function useSetSkillVisibility(id: () => string) {
  return useSkillMutation((visibility: string) => api.post<Skill>(`/skills/${id()}/visibility`, { visibility }));
}

export function useSetSkillArchived(id: () => string) {
  return useSkillMutation((archived: boolean) =>
    api.post<Skill>(`/skills/${id()}/${archived ? 'archive' : 'restore'}`, {})
  );
}

export function useDeleteSkill(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: () => api.delete<void>(`/skills/${id()}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  }));
}

export function useImportSkill() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (file: File) => importSkill(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  }));
}

async function importSkill(file: File): Promise<Skill> {
  const body = new FormData();
  body.append('archive', file, file.name);

  const headers: Record<string, string> = {};
  const tenant = currentTenant();
  if (tenant) headers[TENANT_HEADER] = tenant;

  const res = await fetch('/api/skills/import', { method: 'POST', body, headers });
  if (!res.ok) throw parseApiError(await res.text().catch(() => ''), res.status, `Error: ${res.status}`);
  return res.json() as Promise<Skill>;
}
