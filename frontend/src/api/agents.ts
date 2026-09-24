import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { api, type Agent } from './client';
import { createAppQuery } from '~/lib/create-app-query';
import type { SkillFlags } from './skills';
import type { StoreFilter } from './store';

export const agentKeys = {
  all: ['agents'] as const,
  list: () => [...agentKeys.all, 'list'] as const,
  store: (filter: StoreFilter, query: string) => [...agentKeys.all, 'store', filter, query] as const,
  detail: (id: string) => [...agentKeys.all, 'detail', id] as const,
  delivery: (id: string) => [...agentKeys.all, 'delivery', id] as const,
  models: () => [...agentKeys.all, 'models'] as const,
};

export interface StoreAgent extends Agent {
  origin: string;
  visibility: string;
  disabled: boolean;
  disableable: boolean;
  createdBy: string | null;
  imageOwned: boolean;
  builderChatId: string | null;
  live: boolean;
  defaultEnvironmentId: string | null;
  profileEnvironmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileSkill {
  skillId: string;
  name: string;
  displayName: string | null;
  /** The Version row the pin points at — what Undo after Remove re-pins, rather than the latest. */
  pinnedVersionId: string;
  pinnedVersion: number;
  latestVersion: number | null;
  updateAvailable: boolean;
  visibility: string;
  flags: SkillFlags;
}

export interface AgentProfile {
  environmentId: string;
  promptBody: string | null;
  model: string | null;
  variant: string | null;
  updatedAt: string | null;
  skills: AgentProfileSkill[] | null;
}

export interface ShippedSkill {
  skillId: string | null;
  name: string;
  displayName: string | null;
  version: number | null;
}

export interface AgentDetail extends StoreAgent {
  settings: { defaultEnvironmentId: string | null; platformApi: boolean };
  profiles: AgentProfile[];
  shippedSkills: ShippedSkill[];
  projectCount: number;
}

/** The convergence summary issue 35 adds to `GET /agents/:id/delivery`. */
export interface AgentDeliverySummary {
  total: number;
  converged: number;
  omitted: Array<{ name: string; environments: number }>;
}

export interface CatalogModel {
  /** The `provider/model` pair the profile route takes. */
  id: string;
  name: string;
  efforts: string[];
}

export interface CatalogProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

export interface CreateAgentDto {
  displayName: string;
  description?: string | null;
}

export interface UpdateAgentProfileDto {
  promptBody: string;
  model: string;
  variant: string | null;
}

export interface PublishApplied {
  prompt: 'changed' | 'same';
  model: { from: string | null; to: string | null } | null;
  skills: { added: string[]; removed: string[]; repinned: string[] };
}

export function useAgents() {
  return createAppQuery(() => ({
    queryKey: agentKeys.list(),
    queryFn: () => api.get<Agent[]>('/agents'),
    refetchOnWindowFocus: false,
  }));
}

function storePath(filter: StoreFilter, query: string): string {
  const params = new URLSearchParams({ filter });
  if (query) params.set('q', query);
  return `/agents/store?${params.toString()}`;
}

export function useStoreAgents(filter: () => StoreFilter, query: () => string) {
  return createAppQuery(() => ({
    queryKey: agentKeys.store(filter(), query()),
    queryFn: () => api.get<StoreAgent[]>(storePath(filter(), query())),
    placeholderData: (previous: StoreAgent[] | undefined) => previous,
  }));
}

export function useAgent(id: () => string, enabled: () => boolean = () => true) {
  return createAppQuery(() => ({
    queryKey: agentKeys.detail(id()),
    queryFn: () => api.get<AgentDetail>(`/agents/${id()}`),
    enabled: enabled(),
  }));
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (dto: CreateAgentDto) => api.post<AgentDetail>('/agents', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  }));
}

export function deliverySummary(payload: unknown): AgentDeliverySummary | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const summary = (payload as { summary?: unknown }).summary;
  if (!summary || typeof summary !== 'object') return null;
  const { total, converged } = summary as { total?: unknown; converged?: unknown };
  if (typeof total !== 'number' || typeof converged !== 'number') return null;
  return { total, converged, omitted: omittedSkills((payload as { environments?: unknown }).environments) };
}

function omittedSkills(environments: unknown): AgentDeliverySummary['omitted'] {
  if (!Array.isArray(environments)) return [];
  const counts = new Map<string, number>();
  for (const environment of environments) {
    const names = (environment as { omittedSkills?: unknown })?.omittedSkills;
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name === 'string') counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, environmentCount]) => ({ name, environments: environmentCount }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function useAgentDelivery(id: () => string, enabled: () => boolean) {
  return createAppQuery(() => ({
    queryKey: agentKeys.delivery(id()),
    queryFn: async () => deliverySummary(await api.get<unknown>(`/agents/${id()}/delivery`)),
    enabled: enabled(),
    reconcile: false as const,
  }));
}

export function useAgentModels() {
  return createAppQuery(() => ({
    queryKey: agentKeys.models(),
    queryFn: () => api.get<CatalogProvider[]>('/agents/models'),
    staleTime: Infinity,
  }));
}

/** Every write below refetches the detail query, which is what redraws badges, drift and the strip. */
function useAgentMutation<TVariables, TResult>(id: () => string, run: (agentId: string, input: TVariables) => Promise<TResult>) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (input: TVariables) => run(id(), input),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  }));
}

export function useUpdateAgent(id: () => string) {
  return useAgentMutation(id, (agentId, dto: { displayName?: string; description?: string | null }) =>
    api.patch<AgentDetail>(`/agents/${agentId}`, dto)
  );
}

export function useUpdateAgentProfile(id: () => string) {
  return useAgentMutation(id, (agentId, dto: UpdateAgentProfileDto) =>
    api.put<AgentDetail>(`/agents/${agentId}/profile`, dto)
  );
}

export function useSetAgentSkill(id: () => string) {
  return useAgentMutation(id, (agentId, input: { skillId: string; versionId?: string }) =>
    api.put<AgentProfileSkill[]>(`/agents/${agentId}/skills/${input.skillId}`, { versionId: input.versionId })
  );
}

export function useRemoveAgentSkill(id: () => string) {
  return useAgentMutation(id, (agentId, skillId: string) =>
    api.delete<AgentProfileSkill[]>(`/agents/${agentId}/skills/${skillId}`)
  );
}

export function usePublishAgent(id: () => string) {
  return useAgentMutation(id, (agentId, environmentId: string) =>
    api.post<{ applied: PublishApplied }>(`/agents/${agentId}/publish`, { environmentId })
  );
}

export function useUpdateAgentSettings(id: () => string) {
  return useAgentMutation(id, (agentId, defaultEnvironmentId: string) =>
    api.put<AgentDetail>(`/agents/${agentId}/settings`, { defaultEnvironmentId })
  );
}

export function useSetAgentVisibility(id: () => string) {
  return useAgentMutation(id, (agentId, visibility: string) =>
    api.post<AgentDetail>(`/agents/${agentId}/visibility`, { visibility })
  );
}

export function useSetAgentDisabled(id: () => string) {
  return useAgentMutation(id, (agentId, disabled: boolean) =>
    api.post<AgentDetail>(`/agents/${agentId}/${disabled ? 'disable' : 'enable'}`)
  );
}

export function useDuplicateAgent(id: () => string) {
  return useAgentMutation(id, (agentId, displayName: string) =>
    api.post<AgentDetail>(`/agents/${agentId}/duplicate`, { displayName })
  );
}

export function useDeleteAgent(id: () => string) {
  return useAgentMutation(id, (agentId, _input: void) => api.delete<void>(`/agents/${agentId}`));
}
