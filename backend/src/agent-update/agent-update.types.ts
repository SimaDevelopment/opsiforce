export const AGENT_WORKSPACE_UPDATE_QUEUE = 'agent-workspace-update';

export const AgentUpdateStatus = {
  Pending: 'pending',
  Running: 'running',
  ReloadPending: 'reload_pending',
  Applied: 'applied',
  Conflict: 'conflict',
  Failed: 'failed',
} as const;

export type AgentUpdateMode = 'content' | 'full';

export interface AgentEnvironmentJobData {
  projectEnvironmentId: string;
  /** The agent image package: the Agent's name for a Built-in Agent, `custom` otherwise. */
  packageName: string;
  targetVersion: string;
  mode: AgentUpdateMode;
}

export interface AgentReloadJobData {
  updateId: string;
  attempt: number;
}

export type AgentSweepJobData = Record<string, never>;

export type AgentUpdateJobData = AgentEnvironmentJobData | AgentReloadJobData | AgentSweepJobData;

export interface AgentUpdateConflict {
  migrationId: string;
  path: string;
  reason: string;
}

export interface AgentMigrationFailure {
  migrationId: string;
  error: string;
}

export interface AgentOwnedSkillsResult {
  written: string[];
  removed: string[];
}

export interface AgentWorkspaceMigrationSummary {
  agentName: string;
  targetVersion: string;
  appliedMigrations: string[];
  skippedMigrations: string[];
  failedMigrations: AgentMigrationFailure[];
  conflicts: AgentUpdateConflict[];
  ownedSkills: AgentOwnedSkillsResult;
  configChanged: boolean;
  requiresPodRecreate: boolean;
  status: 'applied' | 'conflict' | 'failed';
  error?: string;
}
