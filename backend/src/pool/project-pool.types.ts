export const PROJECT_POOL_QUEUE = 'project-pool';
export const PROJECT_POOL_TEARDOWN_QUEUE = 'project-pool-teardown';

export const ProjectPoolJob = {
  Replenish: 'replenish',
  Recycle: 'recycle',
  Integrity: 'integrity',
  Teardown: 'teardown',
} as const;

export interface ReplenishJobData {
  agentId: string;
}

export interface RecycleJobData {
  projectId: string;
  reason: string;
}

export interface IntegrityJobData {
  triggeredBy: 'boot' | 'interval' | 'agent-change';
}

export interface TeardownJobData {
  projectId: string;
  bifrostProjectId: string | null;
  bifrostKeyIds: string[];
  podName: string;
  directory: string;
}

export type ProjectPoolJobData = ReplenishJobData | RecycleJobData | IntegrityJobData;
