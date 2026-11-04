import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { AgentSessionGateway } from '../agent-session/agent-session.gateway';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { hasRunningPod } from '../project-environment/running-pod';
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

interface WatchedEnvironment {
  projectId: string;
  runningSessions: Set<string>;
  pendingRequests: Set<string>;
  observations: number;
  cancelReread: (() => void) | null;
}

interface EnvironmentLevel {
  working: boolean;
  waiting: boolean;
}

function levelOf(watched: WatchedEnvironment | undefined): EnvironmentLevel {
  return { working: (watched?.runningSessions.size ?? 0) > 0, waiting: (watched?.pendingRequests.size ?? 0) > 0 };
}

@Injectable()
export class AgentStatusService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentStatusService.name);
  private readonly watchedEnvironments = new Map<string, WatchedEnvironment>();
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
    for (const watched of this.watchedEnvironments.values()) {
      watched.cancelReread?.();
    }
    this.watchedEnvironments.clear();
  }

  runStarted(projectId: string, environmentId: string, sessionId: string): void {
    this.holdPod(environmentId);
    this.change(projectId, environmentId, (watched) => watched.runningSessions.add(sessionId));
  }

  runEnded(projectId: string, environmentId: string, sessionId: string): void {
    if (!this.watchedEnvironments.get(environmentId)?.runningSessions.has(sessionId)) return;
    this.change(projectId, environmentId, (watched) => watched.runningSessions.delete(sessionId));
    if (!levelOf(this.watchedEnvironments.get(environmentId)).working) this.holdPod(environmentId);
  }

  inputRequested(projectId: string, environmentId: string, requestId: string): void {
    this.change(projectId, environmentId, (watched) => watched.pendingRequests.add(requestId));
  }

  inputResolved(projectId: string, environmentId: string, requestId: string): void {
    if (!this.watchedEnvironments.get(environmentId)?.pendingRequests.has(requestId)) return;
    this.change(projectId, environmentId, (watched) => watched.pendingRequests.delete(requestId));
  }

  clear(projectId: string, environmentId: string): void {
    this.replace(projectId, environmentId, [], []);
  }

  statusOf(projectId: string): AgentStatus {
    return this.workingEnvironmentsOf(projectId).size > 0 ? AgentStatus.Working : AgentStatus.Idle;
  }

  waitingForInput(projectId: string): boolean {
    for (const watched of this.watchedEnvironments.values()) {
      if (watched.projectId === projectId && levelOf(watched).waiting) return true;
    }
    return false;
  }

  workingEnvironmentsOf(projectId: string): Set<string> {
    const environments = new Set<string>();
    for (const [environmentId, watched] of this.watchedEnvironments) {
      if (watched.projectId === projectId && levelOf(watched).working) environments.add(environmentId);
    }
    return environments;
  }

  private change(projectId: string, environmentId: string, edit: (watched: WatchedEnvironment) => void): void {
    const existing = this.watchedEnvironments.get(environmentId);
    const before = levelOf(existing);
    const watched = existing ?? this.watch(projectId, environmentId);
    watched.observations += 1;
    edit(watched);
    const after = levelOf(watched);
    if (!after.working && !after.waiting) this.unwatch(environmentId);
    this.publishIfChanged(projectId, before, after);
  }

  private replace(projectId: string, environmentId: string, sessionIds: string[], requestIds: string[]): void {
    const before = levelOf(this.watchedEnvironments.get(environmentId));
    this.unwatch(environmentId);
    if (sessionIds.length > 0 || requestIds.length > 0) {
      const watched = this.watch(projectId, environmentId);
      for (const sessionId of sessionIds) watched.runningSessions.add(sessionId);
      for (const requestId of requestIds) watched.pendingRequests.add(requestId);
    }
    this.publishIfChanged(projectId, before, levelOf(this.watchedEnvironments.get(environmentId)));
  }

  private watch(projectId: string, environmentId: string): WatchedEnvironment {
    const watched: WatchedEnvironment = {
      projectId,
      runningSessions: new Set(),
      pendingRequests: new Set(),
      observations: 0,
      cancelReread: null,
    };
    this.watchedEnvironments.set(environmentId, watched);
    this.scheduleReread(environmentId, watched);
    return watched;
  }

  private unwatch(environmentId: string): void {
    this.watchedEnvironments.get(environmentId)?.cancelReread?.();
    this.watchedEnvironments.delete(environmentId);
  }

  private publishIfChanged(projectId: string, before: EnvironmentLevel, after: EnvironmentLevel): void {
    if (before.working !== after.working || before.waiting !== after.waiting) {
      void this.projectEvents.publish(projectId);
    }
  }

  private scheduleReread(environmentId: string, watched: WatchedEnvironment): void {
    watched.cancelReread = this.startTimer(() => this.reread(environmentId, watched), AGENT_STATUS_REREAD_MS);
  }

  private async reread(environmentId: string, watched: WatchedEnvironment): Promise<void> {
    watched.cancelReread = null;
    const observationsBefore = watched.observations;
    const env = await this.projectEnvironmentService.findByIdOrNull(environmentId).catch(() => null);
    const [runningSessions, pendingRequests] = env
      ? await Promise.all([this.readRunningSessions(env), this.readPendingRequests(env)])
      : [[], []];

    if (this.watchedEnvironments.get(environmentId) !== watched) return;
    if (env && hasRunningPod(env)) this.holdPod(environmentId);
    if (watched.observations !== observationsBefore) {
      this.scheduleReread(environmentId, watched);
      return;
    }
    this.replace(watched.projectId, environmentId, runningSessions, pendingRequests);
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

  private async readPendingRequests(env: ProjectEnvironmentContext): Promise<string[]> {
    if (!hasRunningPod(env)) return [];
    try {
      return await this.agentSessions.pendingInputRequests(env);
    } catch (err) {
      this.logger.warn(`Agent status re-read of ${env.id} could not list pending input: ${(err as Error).message}`);
      return [];
    }
  }

  private async reconcile(): Promise<void> {
    const envs = (await this.projectEnvironmentService.listByStatus(ProjectStatus.Active)).filter(hasRunningPod);
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
    const [{ sessionIds, busy }, requestIds] = await Promise.all([
      this.agentSessions.activeSessions(env),
      this.agentSessions.pendingInputRequests(env),
    ]);
    if (busy || requestIds.length > 0) this.replace(env.projectId, env.id, sessionIds, requestIds);
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
    if (!env || !hasRunningPod(env)) {
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
