export interface RuntimeAgentIdentity {
  importedAgent: string | null;
  agentName: string;
}

export function runtimeAgentSlug(project: RuntimeAgentIdentity): string {
  return project.importedAgent ?? project.agentName;
}
