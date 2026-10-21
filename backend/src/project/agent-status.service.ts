import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { AgentSessionGateway } from '../agent-session/agent-session.gateway';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { TimeoutService } from '../timeout/timeout.service';
import { ProjectEventsService } from './project-events.service';
import { AgentStatus, ProjectStatus } from './project.types';

const RECONCILE_RETRY_BASE_MS = 5 * 1000;
const RECONCILE_RETRY_MAX_MS = 60 * 1000;
const AGENT_STATUS_REREAD_MS = 60 * 1000;

export const AGENT_STATUS_TIMER = 'AGENT_STATUS_TIMER';
export type StartTimer = (task: () => Promise<void>, delayMs: number) => () => void;

export const unrefTimer: StartTimer = (task, delayMs) => {
  const timer = setTimeout(() => void task(), delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

interface WorkingEnvironment {
  projectId: string;
  runningSessions: Set<string>;
  observations: number;
  cancelReread: (() => void) | null;
}

@Injectable()
export class AgentStatusService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentStatusService.name);
  private readonly workingEnvironments = new Map<string, WorkingEnvironment>();
  private readonly reconcileRetries = new Map<string, number>();
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly projectEvents: ProjectEventsService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    @Inject(forwardRef(() => AgentSessionGateway))
    private readonly agentSessions: AgentSessionGateway,
    @Inject(AGENT_STATUS_TIMER) private readonly startTimer: StartTimer,
    private readonly timeouts: TimeoutService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile().catch((err) => {
      this.logger.warn(`Agent status boot reconcile failed: ${(err as Error).message}`);
    });
  }

  onModuleDestroy(): void {
    for (const timer of this.reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this.reconcileTimers.clear();
    this.reconcileRetries.clear();
    for (const working of this.workingEnvironments.values()) {
      working.cancelReread?.();
    }
    this.workingEnvironments.clear();
  }

  runStarted(projectId: string, environmentId: string, sessionId: string): void {
    this.holdPod(environmentId);
    const working = this.workingEnvironments.get(environmentId);
    if (working) {
      working.observations += 1;
      working.runningSessions.add(sessionId);
      return;
    }
    this.replaceRunningSessions(projectId, environmentId, [sessionId]);
  }

  runEnded(projectId: string, environmentId: string, sessionId: string): void {
    const working = this.workingEnvironments.get(environmentId);
    if (!working?.runningSessions.has(sessionId)) return;
    working.observations += 1;
    working.runningSessions.delete(sessionId);
    if (working.runningSessions.size > 0) return;
    this.replaceRunningSessions(projectId, environmentId, []);
    this.holdPod(environmentId);
  }

  clear(projectId: string, environmentId: string): void {
    this.replaceRunningSessions(projectId, environmentId, []);
  }

  statusOf(projectId: string): AgentStatus {
    return this.workingEnvironmentsOf(projectId).size > 0 ? AgentStatus.Working : AgentStatus.Idle;
  }

  workingEnvironmentsOf(projectId: string): Set<string> {
    const environments = new Set<string>();
    for (const [environmentId, working] of this.workingEnvironments) {
      if (working.projectId === projectId) environments.add(environmentId);
    }
    return environments;
  }

  private replaceRunningSessions(projectId: string, environmentId: string, sessionIds: string[]): void {
    const previous = this.workingEnvironments.get(environmentId);
    previous?.cancelReread?.();
    this.workingEnvironments.delete(environmentId);

    if (sessionIds.length > 0) {
      const working: WorkingEnvironment = {
        projectId,
        runningSessions: new Set(sessionIds),
        observations: 0,
        cancelReread: null,
      };
      this.workingEnvironments.set(environmentId, working);
      this.scheduleReread(environmentId, working);
    }

    const wasWorking = previous !== undefined;
    const isWorking = sessionIds.length > 0;
    if (wasWorking !== isWorking) {
      void this.projectEvents.publish(projectId);
    }
  }

  private scheduleReread(environmentId: string, working: WorkingEnvironment): void {
    working.cancelReread = this.startTimer(() => this.reread(environmentId, working), AGENT_STATUS_REREAD_MS);
  }

  private async reread(environmentId: string, working: WorkingEnvironment): Promise<void> {
    working.cancelReread = null;
    const observationsBefore = working.observations;
    const env = await this.projectEnvironmentService.findByIdOrNull(environmentId).catch(() => null);
    const runningSessions = env ? await this.readRunningSessions(env) : [];

    if (this.workingEnvironments.get(environmentId) !== working) return;
    if (env && hasRunningPod(env)) this.holdPod(environmentId);
    if (working.observations !== observationsBefore) {
      this.scheduleReread(environmentId, working);
      return;
    }
    this.replaceRunningSessions(working.projectId, environmentId, runningSessions);
  }

  private holdPod(environmentId: string): void {
    this.timeouts.touch(environmentId).catch((err) => {
      this.logger.warn(`Agent keep-alive touch of ${environmentId} failed: ${(err as Error).message}`);
    });
  }

  private async readRunningSessions(env: ProjectEnvironmentContext): Promise<string[]> {
    if (!hasRunningPod(env)) return [];
    try {
      return (await this.agentSessions.activeSessions(env)).sessionIds;
    } catch (err) {
      this.logger.warn(`Agent status re-read of ${env.id} found no reachable pod: ${(err as Error).message}`);
      return [];
    }
  }

  private async reconcile(): Promise<void> {
    const envs = (await this.projectEnvironmentService.listByStatus(ProjectStatus.Active)).filter(
      (env) => !env.disabled && env.podIp
    );
    if (envs.length === 0) return;

    const results = await Promise.allSettled(envs.map((env) => this.reconcileEnvironment(env)));
    const working = results.filter((result) => result.status === 'fulfilled' && result.value).length;
    const failed = results.filter((result) => result.status === 'rejected').length;
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') this.scheduleReconcileRetry(envs[index].id);
    }
    this.logger.log(
      `Agent status reconciled across ${envs.length} active environment(s); ${working} working; ${failed} retrying`
    );
  }

  private async reconcileEnvironment(env: ProjectEnvironmentContext): Promise<boolean> {
    const { sessionIds, busy } = await this.agentSessions.activeSessions(env);
    if (busy) this.replaceRunningSessions(env.projectId, env.id, sessionIds);
    return busy;
  }

  private scheduleReconcileRetry(envId: string): void {
    if (this.reconcileTimers.has(envId)) return;
    const attempts = (this.reconcileRetries.get(envId) ?? 0) + 1;
    this.reconcileRetries.set(envId, attempts);
    const delay = Math.min(RECONCILE_RETRY_BASE_MS * Math.pow(2, attempts - 1), RECONCILE_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(envId);
      void this.retryReconcileEnvironment(envId);
    }, delay);
    this.reconcileTimers.set(envId, timer);
  }

  private async retryReconcileEnvironment(envId: string): Promise<void> {
    const env = await this.projectEnvironmentService.findByIdOrNull(envId).catch(() => null);
    if (!env || env.disabled || env.status !== ProjectStatus.Active || !env.podIp) {
      this.reconcileRetries.delete(envId);
      return;
    }

    try {
      await this.reconcileEnvironment(env);
      this.reconcileRetries.delete(envId);
    } catch (err) {
      this.logger.warn(`Agent status reconcile retry failed for ${envId}: ${(err as Error).message}`);
      this.scheduleReconcileRetry(envId);
    }
  }
}

function hasRunningPod(env: ProjectEnvironmentContext): boolean {
  return !env.disabled && env.status === ProjectStatus.Active && !!env.podIp;
}
