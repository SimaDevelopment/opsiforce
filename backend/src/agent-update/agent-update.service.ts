import { Inject, Injectable, Logger, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../../db';
import { agents, projectAgentUpdates } from '../../db/schema';
import { AgentSessionGateway } from '../agent-session/agent-session.gateway';
import { PodResponded } from '../agent-session/agent-session.errors';
import type { PodEnvironmentRef } from '../agent-session/agent-session.types';
import { ProjectService } from '../project/project.service';
import { ProjectStatus } from '../project/project.types';
import { readAgentConfig, type AgentModelSelection, type AgentRuntimeConfig } from '../agent/agent-config';
import {
  AGENT_WORKSPACE_UPDATE_QUEUE,
  AgentUpdateStatus,
  type AgentProjectJobData,
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
  private readonly agentConfig: AgentRuntimeConfig;

  constructor(
    @InjectQueue(AGENT_WORKSPACE_UPDATE_QUEUE)
    private readonly queue: Queue<AgentUpdateJobData>,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => ProjectService))
    private readonly projectService: ProjectService,
    @Inject(forwardRef(() => AgentSessionGateway))
    private readonly agentSessions: AgentSessionGateway
  ) {
    this.agentConfig = readAgentConfig();
  }

  async onApplicationBootstrap(): Promise<void> {
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

  private async reapStaleRunningRows(): Promise<void> {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const now = new Date();
    await db
      .update(projectAgentUpdates)
      .set({
        status: AgentUpdateStatus.Failed,
        error: 'process_terminated',
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(projectAgentUpdates.status, AgentUpdateStatus.Running), lt(projectAgentUpdates.startedAt, cutoff)));
  }

  registryAgentVersions(): ReadonlyMap<string, string> {
    return this.agentConfig.versions;
  }

  agentModelSelection(agentName: string): AgentModelSelection | undefined {
    return this.agentConfig.modelSelections.get(agentName);
  }

  private registryStamp(): string {
    return (
      [...this.agentConfig.versions.entries()]
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

  async enqueueProjectUpdates(rows: Array<{ id: string }>, agentName: string, targetVersion: string): Promise<void> {
    if (rows.length === 0) return;
    await this.queue.addBulk(rows.map((row) => this.buildProjectJob(row.id, agentName, targetVersion)));
  }

  private buildProjectJob(projectId: string, agentName: string, targetVersion: string) {
    return {
      name: 'project',
      data: { projectId, agentName, targetVersion } satisfies AgentProjectJobData,
      opts: {
        jobId: this.queueJobId('project', agentName, targetVersion, projectId, 'stable'),
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

  async resolveAgentId(agentName: string): Promise<string> {
    const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, agentName)).limit(1);
    if (existing) return existing.id;

    const agentId = crypto.randomUUID();
    await db.insert(agents).values({ id: agentId, name: agentName }).onConflictDoNothing();
    const [created] = await db.select({ id: agents.id }).from(agents).where(eq(agents.name, agentName)).limit(1);
    if (!created) throw new Error(`Failed to resolve agent: ${agentName}`);
    return created.id;
  }

  async applyPendingReloadForProject(projectId: string): Promise<ReloadOutcome | null> {
    const [update] = await db
      .select()
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectId, projectId),
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
      .where(and(eq(projectAgentUpdates.projectId, update.projectId), eq(projectAgentUpdates.agentId, update.agentId)))
      .orderBy(desc(projectAgentUpdates.createdAt))
      .limit(1);
    if (latest?.id !== update.id) return { status: 'skipped', reloadStatus: 'skipped:superseded' };

    const project = await this.projectService.findOneById(update.projectId).catch(() => null);
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
