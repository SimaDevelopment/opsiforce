import type { PodClass } from '../pod/pod-classes';
import type { PodFailureReason } from '../pod/pod.service';
import type { ProjectStatus } from '../project/project.types';
import type { AgentUpdateStatus } from '../agent-update/agent-update.types';

type AgentUpdateStatusValue = (typeof AgentUpdateStatus)[keyof typeof AgentUpdateStatus];

export interface KeepAliveActivityView {
  lastTouchMs: number | null;
  remainingMs: number | null;
}

export interface PodKeepAliveView {
  agent: KeepAliveActivityView;
  app: KeepAliveActivityView;
}

export type PodPhase = 'running' | 'pending' | 'succeeded' | 'failed' | 'terminating' | 'unknown';

export type PodStatusReason = PodFailureReason | 'Terminating';

export interface PodStatusView {
  phase: PodPhase;
  ready: boolean;
  restartCount: number;
  reason: PodStatusReason | null;
}

export interface PodResourcesView {
  podClass: PodClass;
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}

export interface PodTimeoutView {
  agentIdleMs: number;
  appIdleMs: number;
}

export interface PodSkillDeliveryView {
  converged: boolean;
  pendingSkills: string[];
  failedAt: number | null;
  error: string | null;
}

export interface PodAgentUpdateView {
  status: AgentUpdateStatusValue;
  targetVersion: string;
  requiresPodRecreate: boolean;
  error: string | null;
}

export interface PodDetailView {
  podIp: string | null;
  startedAtMs: number | null;
}

export interface PodRowView {
  projectEnvironmentId: string;
  environmentId: string | null;
  environmentName: string;
  environmentSlug: string | null;
  isDefault: boolean;
  podName: string;
  status: PodStatusView;
  ageMs: number;
  resources: PodResourcesView;
  timeout: PodTimeoutView;
  keepAlive: PodKeepAliveView;
  drift: boolean;
  dbStatus: ProjectStatus;
  skillDelivery: PodSkillDeliveryView;
  agentUpdate: PodAgentUpdateView | null;
  detail: PodDetailView;
}

export interface PodProjectGroupView {
  projectId: string;
  projectTitle: string | null;
  environments: PodRowView[];
  ghostCount: number;
}

export interface PodsView {
  projects: PodProjectGroupView[];
}
