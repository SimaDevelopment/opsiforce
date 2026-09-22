import { Inject, Injectable, Logger, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { agents, projectAgentUpdates } from '../../db/schema';
import { AgentSessionGateway } from '../agent-session/agent-session.gateway';
import { PodResponded } from '../agent-session/agent-session.errors';
import type { PodEnvironmentRef } from '../agent-session/agent-session.types';
import { ProjectService } from '../project/project.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { ProjectStatus } from '../project/project.types';
import { type AgentModelSelection } from '../agent/agent-config';
import { AgentReconcilerService } from '../agent/agent-reconciler.service';
import { SkillReconcilerService } from '../store/skill-reconciler.service';
import { AgentUpdateK8sService } from './agent-update.k8s.service';
import { agentUpdateStaleAfterMs, reapStaleRunningAgentUpdates } from './agent-update.reaper';
import {
  AGENT_WORKSPACE_UPDATE_QUEUE,
  AgentUpdateStatus,
  type AgentEnvironmentJobData,
  type AgentReloadJobData,
  type AgentSweepJobData,
  type AgentUpdateJobData,
} from './agent-update.types';

const RELOAD_RETRY_DELAYS_MS = [5, 15, 30, 60].map((m) => m * 60 * 1000);

export type ReloadOutcome = {
  status: 'applied' | 'pending' | 'skipped';
  reloadStatus: string;
  podRecreated?: boolean;
  error?: string;
};

type SessionStatus = { busy: true } | { busy: false } | { error: string; reloadStatus: string };

@Injectable()
export class AgentUpdateService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgentUpdateService.name);
  private agentVersions = new Map<string, string>();
  private agentModelSelections = new Map<string, AgentModelSelection>();

  constructor(
    @InjectQueue(AGENT_WORKSPACE_UPDATE_QUEUE)
    private readonly queue: Queue<AgentUpdateJobData>,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => ProjectService))
    private readonly projectService: ProjectService,
    @Inject(forwardRef(() => AgentSessionGateway))
    private readonly agentSessions: AgentSessionGateway,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly k8sService: AgentUpdateK8sService,
    private readonly agentReconciler: AgentReconcilerService,
    private readonly skillReconciler: SkillReconcilerService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.agentReconciler.ready();
    await this.skillReconciler.ready();
    await this.loadAgentRuntime();
    if (!this.configService.get<boolean>('agentWorkspaceUpdateOnStartup', true)) return;
    await this.reapStaleRunningRows().catch((err) => {
      this.logger.warn(`Failed to reap stale running rows: ${(err as Error).message}`);
    });
    await Promise.all([
      this.enqueueProjectSweep().catch((err) => {
        this.logger.warn(`Failed to enqueue agent workspace update sweep: ${(err as Error).message}`);
      }),
      this.requeueOrphanedReloads().catch((err) => {
        this.logger.warn(`Failed to requeue pending agent reloads: ${(err as Error).message}`);
      }),
    ]);
  }

  /** Public because a Skill delivery must not write to an environment a dead process still claims. */
  async reapStaleRunningRows(): Promise<void> {
    await reapStaleRunningAgentUpdates(agentUpdateStaleAfterMs(this.configService), (updateId) =>
      this.k8sService.isJobRunning(updateId)
    );
  }

  async loadAgentRuntime(): Promise<void> {
    const rows = await db
      .select({
        name: agents.name,
        version: agents.version,
        model: agents.model,
        variant: agents.variant,
      })
      .from(agents)
      .where(and(isNull(agents.tenantId), eq(agents.origin, 'built_in')));

    this.agentVersions = new Map(
      rows.filter((row) => row.version !== null).map((row) => [row.name, row.version as string])
    );
    this.agentModelSelections = new Map(
      rows
        .filter((row) => row.model !== null)
        .map((row) => [row.name, { model: row.model as string, ...(row.variant ? { variant: row.variant } : {}) }])
    );
  }

  registryAgentVersions(): ReadonlyMap<string, string> {
    return this.agentVersions;
  }

  agentModelSelection(agentName: string): AgentModelSelection | undefined {
    return this.agentModelSelections.get(agentName);
  }

  private registryStamp(): string {
    return (
      [...this.agentVersions.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([agentName, version]) => `${agentName}@${version}`)
        .join('--') || 'empty-registry'
    );
  }

  async enqueueProjectSweep(): Promise<void> {
    await this.queue.add('sweep', {} satisfies AgentSweepJobData, {
      jobId: this.queueJobId('sweep', this.registryStamp(), 'stable'),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  async enqueueEnvironmentUpdates(jobs: AgentEnvironmentJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.queue.addBulk(jobs.map((job) => this.buildEnvironmentJob(job)));
  }

  private buildEnvironmentJob(data: AgentEnvironmentJobData) {
    return {
      name: 'environment',
      data,
      opts: {
        jobId: this.queueJobId(
          'environment',
          data.packageName,
          data.targetVersion,
          data.mode,
          data.projectEnvironmentId,
          'stable'
        ),
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    };
  }

  async enqueueReload(updateId: string, attempt: number): Promise<void> {
    const nextAttempt = Math.max(1, attempt);
    const delay = RELOAD_RETRY_DELAYS_MS[Math.min(nextAttempt - 1, RELOAD_RETRY_DELAYS_MS.length - 1)];
    const data: AgentReloadJobData = { updateId, attempt: nextAttempt };
    await this.queue.add('reload', data, {
      jobId: this.queueJobId('reload', updateId, nextAttempt),
      delay,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  async applyPendingReloadForEnvironment(projectEnvironmentId: string): Promise<ReloadOutcome | null> {
    const [update] = await db
      .select()
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId),
          eq(projectAgentUpdates.status, AgentUpdateStatus.ReloadPending)
        )
      )
      .orderBy(desc(projectAgentUpdates.createdAt))
      .limit(1);
    return update ? this.applyPendingReload(update.id) : null;
  }

  async applyPendingReload(updateId: string): Promise<ReloadOutcome> {
    const [update] = await db.select().from(projectAgentUpdates).where(eq(projectAgentUpdates.id, updateId)).limit(1);
    if (!update) return { status: 'skipped', reloadStatus: 'skipped:update-not-found' };
    if (update.status !== AgentUpdateStatus.ReloadPending) {
      return { status: 'skipped', reloadStatus: `skipped:status-${update.status}` };
    }

    const [latest] = await db
      .select({ id: projectAgentUpdates.id })
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, update.projectEnvironmentId ?? update.projectId),
          eq(projectAgentUpdates.agentId, update.agentId)
        )
      )
      .orderBy(desc(projectAgentUpdates.createdAt))
      .limit(1);
    if (latest?.id !== update.id) return { status: 'skipped', reloadStatus: 'skipped:superseded' };

    const project = await this.projectEnvironmentService
      .findByIdOrNull(update.projectEnvironmentId ?? update.projectId)
      .catch(() => null);
    if (!project) return { status: 'skipped', reloadStatus: 'skipped:project-not-found' };

    if (!update.requiresPodRecreate) {
      return this.applyReload(update.id, 'skipped:not-required');
    }
    if (
      project.status === ProjectStatus.Suspended ||
      project.status === ProjectStatus.Disabled ||
      project.status === ProjectStatus.Failed
    ) {
      return this.applyReload(update.id, 'skipped:no-active-pod');
    }
    if (!project.podIp) {
      return this.deferReload(update.id, 'pending:no-pod-ip');
    }

    const session = await this.checkSession({ id: project.id, podIp: project.podIp });
    if ('error' in session) return this.deferReload(update.id, session.reloadStatus, session.error);
    if (session.busy) return this.deferReload(update.id, 'pending:active-session');

    try {
      await this.projectService.reassignPodById(project.id);
      return this.applyReload(update.id, 'pod-recreate-requested', { podRecreated: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return this.deferReload(update.id, `pending:pod-recreate:${error}`, error);
    }
  }

  private async checkSession(env: PodEnvironmentRef): Promise<SessionStatus> {
    try {
      const { busy } = await this.agentSessions.activeSessions(env);
      return { busy };
    } catch (err) {
      if (err instanceof PodResponded) {
        return {
          error: `Session status returned ${err.status}`,
          reloadStatus: `pending:session-status-${err.status}`,
        };
      }
      const error = err instanceof Error ? err.message : String(err);
      return { error, reloadStatus: `pending:session-status:${error}` };
    }
  }

  private async applyReload(
    updateId: string,
    reloadStatus: string,
    extras: { podRecreated?: boolean } = {}
  ): Promise<ReloadOutcome> {
    await this.writeReloadState(updateId, AgentUpdateStatus.Applied, reloadStatus, new Date());
    return { status: 'applied', reloadStatus, ...extras };
  }

  private async deferReload(updateId: string, reloadStatus: string, error?: string): Promise<ReloadOutcome> {
    await this.writeReloadState(updateId, AgentUpdateStatus.ReloadPending, reloadStatus, null);
    return { status: 'pending', reloadStatus, error };
  }

  private async writeReloadState(
    updateId: string,
    status: typeof AgentUpdateStatus.Applied | typeof AgentUpdateStatus.ReloadPending,
    reloadStatus: string,
    finishedAt: Date | null
  ): Promise<void> {
    await db
      .update(projectAgentUpdates)
      .set({ status, reloadStatus, finishedAt, updatedAt: new Date(), error: null })
      .where(eq(projectAgentUpdates.id, updateId));
  }

  private async requeueOrphanedReloads(): Promise<void> {
    const rows = await db
      .select({ id: projectAgentUpdates.id, attempt: projectAgentUpdates.reloadAttempt })
      .from(projectAgentUpdates)
      .where(eq(projectAgentUpdates.status, AgentUpdateStatus.ReloadPending));
    await Promise.all(rows.map((row) => this.enqueueReload(row.id, Math.max(1, row.attempt))));
  }

  private queueJobId(...parts: Array<number | string>): string {
    return parts.map((part) => String(part).replaceAll(':', '_')).join('__');
  }
}
