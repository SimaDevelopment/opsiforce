import type { AgentServiceSettings } from '../../db/schema';

export interface AgentBundleIdentity {
  displayName: string | null;
  description: string | null;
}

export interface AgentBundleProfile {
  promptBody: string;
  model: string;
  variant: string | null;
}

export interface AgentBundleSkillReference {
  name: string;
  skillId: string;
  skillVersionId: string;
  externalServiceId?: string | null;
  serviceSettings?: AgentServiceSettings | null;
}

/** A Template to write, as the folder it is read from and the hash a save of that folder gives. */
export interface AgentBundleTemplate {
  hash: string;
  sourceDir: string;
}

export interface AgentBundle {
  identity: AgentBundleIdentity;
  profile: AgentBundleProfile;
  skills: AgentBundleSkillReference[];
  template: AgentBundleTemplate | null;
}

export interface SkillPin {
  skillId: string;
  skillVersionId: string;
  serviceSettings?: AgentServiceSettings | null;
}
