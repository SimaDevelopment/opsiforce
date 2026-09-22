import { createMutation, useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api, type ProjectStatus } from './client';
import { projectKeys } from './projects';

export const BUILDER_CHAT_FILTERS = ['active', 'mine', 'archived'] as const;

export type BuilderChatFilter = (typeof BUILDER_CHAT_FILTERS)[number];

export type ChatKind = 'skill_builder_chat' | 'agent_builder_chat';

export type ChatVisibility = 'private' | 'public';

export type BuilderSeed = { skillId: string } | { agentId: string };

export interface ProducedArtifact {
  type: 'skill' | 'agent';
  id: string;
  name: string;
}

export interface BuilderTestProject {
  id: string;
  environmentStatus: ProjectStatus;
}

export interface BuilderChat {
  id: string;
  title: string | null;
  kind: ChatKind;
  visibility: ChatVisibility;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  lastPromptAt: string | null;
  disabled: boolean;
  canOpen: boolean;
  canShare: boolean;
  testProject?: BuilderTestProject;
  produced: ProducedArtifact[];
}

export interface BuilderChatCreated extends BuilderChat {
  /** Rendered from the seed by the backend; the browser is what sends it as the chat's first message. */
  seedPrompt: string | null;
}

export interface CreateBuilderChatDto {
  kind: ChatKind;
  title?: string;
  seed?: BuilderSeed;
}

export const builderKeys = {
  all: ['builder-chats'] as const,
  list: (filter: BuilderChatFilter) => [...builderKeys.all, 'list', filter] as const,
  detail: (id: string) => [...builderKeys.all, 'detail', id] as const,
};

export const CHAT_KIND_LABEL: Record<ChatKind, string> = {
  skill_builder_chat: 'Skill',
  agent_builder_chat: 'Agent',
};

/** A test project is "running" only while its pod is up; suspended and failed read as not running. */
export function isTestProjectRunning(chat: BuilderChat): boolean {
  const status = chat.testProject?.environmentStatus;
  return status === 'active' || status === 'starting';
}

export function useBuilderChats(filter: () => BuilderChatFilter, options?: { enabled?: () => boolean }) {
  return createAppQuery(() => ({
    queryKey: builderKeys.list(filter()),
    queryFn: () => api.get<BuilderChat[]>(`/builder/chats?filter=${filter()}`),
    enabled: options?.enabled ? options.enabled() : true,
    placeholderData: (previous: BuilderChat[] | undefined) => previous,
  }));
}

export function useBuilderChat(id: () => string) {
  return createAppQuery(() => ({
    queryKey: builderKeys.detail(id()),
    queryFn: () => api.get<BuilderChat>(`/builder/chats/${id()}`),
    retry: false,
  }));
}

export function useCreateBuilderChat() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (dto: CreateBuilderChatDto) => api.post<BuilderChatCreated>('/builder/chats', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: builderKeys.all }),
  }));
}

export function useSetBuilderChatVisibility(id: () => string) {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (visibility: ChatVisibility) =>
      api.post<BuilderChat>(`/builder/chats/${id()}/visibility`, { visibility }),
    onSuccess: () => qc.invalidateQueries({ queryKey: builderKeys.all }),
  }));
}

export function useArchiveBuilderChat() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.post<BuilderChat>(`/builder/chats/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: builderKeys.all }),
  }));
}

export function useRestoreBuilderChat() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.post<BuilderChat>(`/builder/chats/${id}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: builderKeys.all }),
  }));
}

export function useDeleteBuilderChat() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.delete<void>(`/builder/chats/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: builderKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  }));
}

export function useDeleteTestProject() {
  const qc = useQueryClient();
  return createMutation(() => ({
    mutationFn: (id: string) => api.delete<void>(`/builder/chats/${id}/test-project`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: builderKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.all });
    },
  }));
}
