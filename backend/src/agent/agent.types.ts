import type { SkillFlags } from '../store/gate';
import { agents } from '../../db/schema';

export type AgentRow = typeof agents.$inferSelect;

export interface AgentResponse {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
}

export interface AgentIdentity {
  name: string;
  displayName: string | null;
  origin: string;
  /** The image folder its Projects' pods boot from: its own slug, or `custom`. */
  package: string;
}

export interface AgentCaller {
  tenantId: string;
  userId: string;
  canManageAgents: boolean;
  createdInChatProjectId?: string | null;
}

export interface AgentProfileSkillResponse {
  skillId: string;
  name: string;
  displayName: string | null;
  /** The Version row the pin points at — what an Undo after Remove re-pins, rather than the latest. */
  pinnedVersionId: string;
  pinnedVersion: number;
  latestVersion: number | null;
  updateAvailable: boolean;
  visibility: string;
  flags: SkillFlags;
}

export interface AgentProfileResponse {
  environmentId: string;
  promptBody: string | null;
  model: string | null;
  variant: string | null;
  updatedAt: Date | null;
  skills: AgentProfileSkillResponse[] | null;
}

export interface AgentSettingsResponse {
  defaultEnvironmentId: string | null;
  platformApi: boolean;
}

export interface AgentSummary extends AgentResponse {
  origin: string;
  visibility: string;
  archived: boolean;
  createdBy: string | null;
  imageOwned: boolean;
  live: boolean;
  defaultEnvironmentId: string | null;
  profileEnvironmentIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends AgentSummary {
  settings: AgentSettingsResponse;
  profiles: AgentProfileResponse[];
  projectCount: number;
}

export interface CreateAgentDto {
  displayName: string;
  description?: string | null;
  model?: string;
  variant?: string | null;
}

export interface UpdateAgentDto {
  displayName?: string;
  description?: string | null;
}

export interface UpdateAgentProfileDto {
  promptBody: string;
  model: string;
  variant?: string | null;
}

export interface SetAgentSkillDto {
  versionId?: string;
}

export interface PublishAgentDto {
  environmentId: string;
}

export interface UpdateAgentSettingsDto {
  defaultEnvironmentId?: string | null;
  platformApi?: boolean;
}

export interface SetAgentVisibilityDto {
  visibility: string;
}

export interface DuplicateAgentDto {
  displayName: string;
}

export interface PublishAgentResponse {
  applied: {
    prompt: 'changed' | 'same';
    model: { from: string | null; to: string | null } | null;
    skills: { added: string[]; removed: string[]; repinned: string[] };
  };
}

export interface AgentDeliveryEnvironment {
  projectEnvironmentId: string;
  projectId: string;
  projectTitle: string | null;
  environmentId: string | null;
  converged: boolean;
  pendingSkills: string[];
  omittedSkills: string[];
  failedAt?: Date;
  error?: string;
}

export interface AgentDeliveryResponse {
  environments: AgentDeliveryEnvironment[];
  summary: { total: number; converged: number };
}

export const DEFAULT_AGENT_NAME = 'app-builder';
export const PLATFORM_SKILL_NAME = 'platform';
