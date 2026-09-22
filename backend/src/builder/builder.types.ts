import type { ChatKind, ChatVisibility, ProjectStatus } from '../project/project.types';

export const BUILDER_CHAT_FILTERS = ['active', 'mine', 'archived'] as const;

export type BuilderChatFilter = (typeof BUILDER_CHAT_FILTERS)[number];

export interface BuilderChatCaller {
  tenantId: string;
  userId: string;
}

export type BuilderSeed = { skillId: string } | { agentId: string };

export interface CreateBuilderChatDto {
  kind: ChatKind;
  title?: string;
  seed?: BuilderSeed;
}

export interface ProducedArtifact {
  type: 'skill' | 'agent';
  id: string;
  name: string;
}

export interface BuilderTestProject {
  id: string;
  environmentStatus: ProjectStatus;
}

export interface SetChatVisibilityDto {
  visibility: ChatVisibility;
}

export interface BuilderChatSummary {
  id: string;
  title: string | null;
  kind: ChatKind;
  visibility: ChatVisibility;
  createdBy: { id: string; displayName: string } | null;
  createdAt: Date;
  lastPromptAt: Date | null;
  disabled: boolean;
  canOpen: boolean;
  /** Whether the caller may flip `visibility`, which only the creator may (ADR-0065). */
  canShare: boolean;
  testProject?: BuilderTestProject;
  produced: ProducedArtifact[];
}

export interface BuilderChatCreated extends BuilderChatSummary {
  /** Rendered from the seed for the client to send: the backend never originates a prompt. */
  seedPrompt: string | null;
}
