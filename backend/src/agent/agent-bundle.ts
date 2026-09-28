export interface AgentBundleIdentity {
  displayName: string | null;
  description: string | null;
  platformApi: boolean;
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
}

export function pinsFromReferences(references: AgentBundleSkillReference[]): SkillPin[] {
  return references.map(({ skillId, skillVersionId }) => ({ skillId, skillVersionId }));
}
