import { useQueryClient } from '@tanstack/solid-query';
import { createAppQuery } from '~/lib/create-app-query';
import { api, type ProjectStatus } from './client';
import { agentKeys } from './agents';
import { skillKeys } from './skills';

export type BuilderSubjectType = 'agent' | 'skill';

export interface BuilderSubjectRef {
  type: BuilderSubjectType;
  id: string;
}

export interface BuilderSubject extends BuilderSubjectRef {
  name: string;
  displayName: string | null;
  disabled: boolean;
}

export interface BuilderTestProject {
  id: string;
  environmentStatus: ProjectStatus;
}

export interface BuilderChat {
  id: string;
  kind: 'skill_builder_chat' | 'agent_builder_chat';
  subject: BuilderSubject;
  createdAt: string;
  lastPromptAt: string | null;
  disabled: boolean;
  testProject?: BuilderTestProject;
}

export function subjectPath(subject: BuilderSubjectRef): string {
  return `/store/${subject.type === 'agent' ? 'agents' : 'skills'}/${subject.id}`;
}

export function builderPath(subject: BuilderSubjectRef): string {
  return `${subjectPath(subject)}/builder`;
}

export function envSearch(env: string | undefined): { env?: string } {
  return env ? { env } : {};
}

export const builderKeys = {
  all: ['builder-chats'] as const,
  forSubject: (subject: BuilderSubjectRef) => [...builderKeys.all, subject.type, subject.id] as const,
};

function subjectBody(subject: BuilderSubjectRef) {
  return subject.type === 'agent' ? { agentId: subject.id } : { skillId: subject.id };
}

export function useBuilderChatFor(subject: () => BuilderSubjectRef) {
  return createAppQuery(() => ({
    queryKey: builderKeys.forSubject(subject()),
    queryFn: () => api.post<BuilderChat>('/builder/chats', subjectBody(subject())),
    retry: false,
  }));
}

export function useRefreshBuilderSubject() {
  const qc = useQueryClient();
  return (subject: BuilderSubjectRef) => {
    void qc.invalidateQueries({ queryKey: builderKeys.forSubject(subject) });
    void qc.invalidateQueries({ queryKey: subject.type === 'agent' ? agentKeys.all : skillKeys.all });
  };
}

export function useForgetBuilderChat() {
  const qc = useQueryClient();
  return (subject: BuilderSubjectRef) => {
    qc.removeQueries({ queryKey: builderKeys.forSubject(subject) });
    void qc.invalidateQueries({ queryKey: subject.type === 'agent' ? agentKeys.all : skillKeys.all });
  };
}
