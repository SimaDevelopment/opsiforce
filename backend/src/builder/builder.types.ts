import type { ChatKind, ProjectStatus } from '../project/project.types';

export interface BuilderChatCaller {
  tenantId: string;
  userId: string;
  canManageSkills: boolean;
  canManageAgents: boolean;
  canManageTenantExternalServices: boolean;
}

export type BuilderSubjectRef = { skillId: string } | { agentId: string } | { externalServiceId: string };

export type BuilderSubjectType = 'skill' | 'agent' | 'external_service';

export interface BuilderSubject {
  type: BuilderSubjectType;
  id: string;
  name: string;
  displayName: string | null;
  disabled: boolean;
}

export interface BuilderTestProject {
  id: string;
  environmentStatus: ProjectStatus;
}

export interface BuilderChatSummary {
  id: string;
  kind: ChatKind;
  subject: BuilderSubject;
  createdAt: Date;
  lastPromptAt: Date | null;
  disabled: boolean;
  testProject?: BuilderTestProject;
}
