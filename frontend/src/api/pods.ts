import { api, type PodClass } from './client';
import { createAppQuery } from '~/lib/create-app-query';

export type KeepAliveSource = 'agent' | 'app';

export type PodPhase = 'running' | 'pending' | 'succeeded' | 'failed' | 'terminating' | 'unknown';

export type PodReason = 'ImagePullBackOff' | 'CrashLoopBackOff' | 'Unschedulable' | 'Terminating';

export type PodDbStatus = 'starting' | 'active' | 'suspended' | 'disabled' | 'failed' | 'publishing';

export interface KeepAliveActivity {
  lastTouchMs: number | null;
  remainingMs: number | null;
}

export interface PodKeepAlive {
  agent: KeepAliveActivity;
  app: KeepAliveActivity;
}

export interface PodStatus {
  phase: PodPhase;
  ready: boolean;
  restartCount: number;
  reason: PodReason | null;
}

export interface PodResources {
  podClass: PodClass;
  cpuMillicores: number;
  memoryRequestMib: number;
  memoryLimitMib: number;
}

export interface PodTimeout {
  agentIdleMs: number;
  appIdleMs: number;
}

export interface PodSkillDelivery {
  converged: boolean;
  pendingSkills: string[];
  failedAt: number | null;
  error: string | null;
}

export type PodAgentUpdateStatus = 'pending' | 'running' | 'reload_pending' | 'applied' | 'conflict' | 'failed';

export interface PodAgentUpdate {
  status: PodAgentUpdateStatus;
  targetVersion: string;
  requiresPodRecreate: boolean;
  error: string | null;
}

export interface PodDetail {
  podIp: string | null;
  startedAtMs: number | null;
}

export interface PodRow {
  projectEnvironmentId: string;
  environmentId: string | null;
  environmentName: string;
  environmentSlug: string | null;
  isDefault: boolean;
  podName: string;
  status: PodStatus;
  ageMs: number;
  resources: PodResources;
  timeout: PodTimeout;
  keepAlive: PodKeepAlive;
  drift: boolean;
  dbStatus: PodDbStatus;
  skillDelivery: PodSkillDelivery;
  agentUpdate: PodAgentUpdate | null;
  detail: PodDetail;
}

export interface PodProjectGroup {
  projectId: string;
  projectTitle: string | null;
  environments: PodRow[];
  ghostCount: number;
}

export interface PodsView {
  projects: PodProjectGroup[];
}

const POLL_INTERVAL_MS = 30000;

export function usePods() {
  return createAppQuery(() => ({
    queryKey: ['pods'],
    queryFn: () => api.get<PodsView>('/pods'),
    refetchInterval: POLL_INTERVAL_MS,
    reconcile: 'projectId',
  }));
}
