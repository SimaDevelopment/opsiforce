import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { and, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../db';
import { agents, projectAgentUpdates, projectEnvironments, projects } from '../../db/schema';
import { CUSTOM_AGENT_PACKAGE, type SkillDeliveryOutcome } from '../delivery/delivery.types';
import { SkillDeliveryService } from '../delivery/skill-delivery.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import { ProjectStatus } from '../project/project.types';
import { AgentUpdateK8sService } from './agent-update.k8s.service';
import { AgentUpdateService } from './agent-update.service';
import {
  AGENT_WORKSPACE_UPDATE_QUEUE,
  AgentUpdateStatus,
  type AgentEnvironmentJobData,
  type AgentReloadJobData,
  type AgentUpdateJobData,
  type AgentWorkspaceMigrationSummary,
} from './agent-update.types';

/** A workspace that is still being created has no ledger to compare and no pod to write into. */
const UNREACHABLE_STATUSES = [ProjectStatus.Pending, ProjectStatus.Claiming];

interface SweepRow {
  projectEnvironmentId: string;
  directory: string;
  isDefault: boolean;
  agentName: string;
  agentId: string;
  agentOrigin: string;
  agentVersion: string | null;
}

/** The Job's own JSON, before it is trusted: every field is whatever the last log line held. */
type RawSummary = Omit<
  AgentWorkspaceMigrationSummary,
  'appliedMigrations' | 'skippedMigrations' | 'failedMigrations' | 'conflicts' | 'ownedSkills' | 'configChanged'
> &
  Partial<Record<'appliedMigrations' | 'skippedMigrations' | 'failedMigrations' | 'conflicts', unknown>> & {
    ownedSkills?: { written?: unknown; removed?: unknown };
    configChanged?: unknown;
  };

interface WorkspaceLedger {
  contentVersion?: string;
  ownedSkills?: string[];
}

@Processor(AGENT_WORKSPACE_UPDATE_QUEUE)
export class AgentUpdateProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger(AgentUpdateProcessor.name);
  private readonly storageMountPath: string;
  private readonly agentImageVersion: string;

  constructor(
    private readonly agentUpdateService: AgentUpdateService,
    private readonly k8sService: AgentUpdateK8sService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly skillDeliveries: SkillDeliveryService,
    private readonly configService: ConfigService
  ) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.agentImageVersion = this.configService.getOrThrow<string>('agentImageVersion');
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutdown signal ${signal ?? ''} received, draining worker...`);
    await this.worker.close();
  }

  async process(job: Job<AgentUpdateJobData>): Promise<void> {
    if (job.name === 'reload') return this.processReload(job.data as AgentReloadJobData);
    if (job.name === 'sweep') return this.processSweep();
    return this.processEnvironment(job.data as AgentEnvironmentJobData);
  }

  private async processSweep(): Promise<void> {
    await this.agentUpdateService.loadAgentRuntime();
    const rows = await this.sweepRows();
    const behind: AgentEnvironmentJobData[] = [];

    for (const row of rows) {
      const packageName = this.packageOf(row);
      const targetVersion = this.contentVersionOf(row);
      if (targetVersion === null) {
        this.logger.warn(
          `Skipping project environment ${row.projectEnvironmentId}: agent ${row.agentName} is not in the merged agent registry`
        );
        continue;
      }
      if (await this.workspaceAtTarget(row.directory, packageName, targetVersion, row.agentOrigin)) continue;
      behind.push({
        projectEnvironmentId: row.projectEnvironmentId,
        packageName,
        targetVersion,
        mode: row.isDefault ? 'full' : 'content',
      });
    }

    await this.recordPending(behind, rows);
    await this.agentUpdateService.enqueueEnvironmentUpdates(behind);
  }

  private async sweepRows(): Promise<SweepRow[]> {
    return db
      .select({
        projectEnvironmentId: projectEnvironments.id,
        directory: projectEnvironments.directory,
        isDefault: projectEnvironments.isDefault,
        agentName: agents.name,
        agentId: agents.id,
        agentOrigin: agents.origin,
        agentVersion: agents.version,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .innerJoin(agents, eq(agents.id, projects.agentId))
      .where(notInArray(projectEnvironments.status, UNREACHABLE_STATUSES));
  }

  /** A Custom Agent Project runs the image's `custom` package; its content is the image itself. */
  private packageOf(row: Pick<SweepRow, 'agentOrigin' | 'agentName'>): string {
    return row.agentOrigin === 'built_in' ? row.agentName : CUSTOM_AGENT_PACKAGE;
  }

  private contentVersionOf(row: Pick<SweepRow, 'agentOrigin' | 'agentVersion'>): string | null {
    return row.agentOrigin === 'built_in' ? row.agentVersion : this.agentImageVersion;
  }

  private async recordPending(behind: AgentEnvironmentJobData[], rows: SweepRow[]): Promise<void> {
    if (behind.length === 0) return;
    const agentIdByEnvironment = new Map(rows.map((row) => [row.projectEnvironmentId, row.agentId]));
    const projectIdByEnvironment = await this.projectIdsFor(behind.map((job) => job.projectEnvironmentId));
    const now = new Date();

    for (const job of behind) {
      const projectId = projectIdByEnvironment.get(job.projectEnvironmentId);
      const agentId = agentIdByEnvironment.get(job.projectEnvironmentId);
      if (!projectId || !agentId) continue;
      if (await this.hasOpenRow(job.projectEnvironmentId, job.targetVersion)) continue;
      await db.insert(projectAgentUpdates).values({
        id: crypto.randomUUID(),
        projectId,
        projectEnvironmentId: job.projectEnvironmentId,
        agentId,
        fromVersion: await this.lastAppliedVersion(job.projectEnvironmentId, agentId),
        targetVersion: job.targetVersion,
        status: AgentUpdateStatus.Pending,
        updatedAt: now,
      });
    }
  }

  private async projectIdsFor(projectEnvironmentIds: string[]): Promise<Map<string, string>> {
    const rows = await db
      .select({ id: projectEnvironments.id, projectId: projectEnvironments.projectId })
      .from(projectEnvironments)
      .where(inArray(projectEnvironments.id, projectEnvironmentIds));
    return new Map(rows.map((row) => [row.id, row.projectId]));
  }

  /** A row already waiting for, or applying, this target is the same outstanding update. */
  private async hasOpenRow(projectEnvironmentId: string, targetVersion: string): Promise<boolean> {
    const [row] = await db
      .select({ id: projectAgentUpdates.id })
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId),
          eq(projectAgentUpdates.targetVersion, targetVersion),
          inArray(projectAgentUpdates.status, [AgentUpdateStatus.Pending, AgentUpdateStatus.Running])
        )
      )
      .limit(1);
    return row !== undefined;
  }

  private async processReload(data: AgentReloadJobData): Promise<void> {
    const result = await this.agentUpdateService.applyPendingReload(data.updateId);
    if (result.status === 'pending') {
      await db
        .update(projectAgentUpdates)
        .set({ reloadAttempt: data.attempt, updatedAt: new Date() })
        .where(eq(projectAgentUpdates.id, data.updateId));
      await this.agentUpdateService.enqueueReload(data.updateId, data.attempt + 1);
    }
  }

  private async processEnvironment(data: AgentEnvironmentJobData): Promise<void> {
    await this.agentUpdateService.loadAgentRuntime();
    const env = await this.projectEnvironmentService.findByIdOrNull(data.projectEnvironmentId);
    if (!env) return;
    if (env.status === ProjectStatus.Pending || env.status === ProjectStatus.Claiming) return;

    const agent = await this.agentOf(env.agentId);
    if (!agent) return;
    if (await this.workspaceAtTarget(env.directory, data.packageName, data.targetVersion, agent.origin)) {
      await this.closePendingRows(env.id);
      return;
    }

    const updateId = await this.claimEnvironment(env, data);

    try {
      const result = await this.k8sService.run({
        updateId,
        projectEnvironmentId: env.id,
        directory: env.directory,
        packageName: data.packageName,
        targetVersion: data.targetVersion,
        mode: data.mode,
      });
      const summary = await this.readSummary(env.directory, data.packageName, result.logs);
      const succeeded = result.succeeded && summary.status !== 'failed';

      if (succeeded) await this.reconcileSkillsInline(env, agent.origin, updateId);
      await this.recordOutcome(updateId, summary, result.succeeded);

      if (this.needsDeferredReload(env, summary)) {
        const reload = await this.agentUpdateService.applyPendingReload(updateId);
        if (reload.status === 'pending') await this.agentUpdateService.enqueueReload(updateId, 1);
      }

      if (!succeeded) throw new Error(summary.error ?? 'Agent update job failed');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db
        .update(projectAgentUpdates)
        .set({
          status: AgentUpdateStatus.Failed,
          error,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectAgentUpdates.id, updateId));
      this.logger.warn(`Agent update failed for environment ${env.id}: ${error}`);
      throw err;
    }
  }

  private async claimEnvironment(env: ProjectEnvironmentContext, data: AgentEnvironmentJobData): Promise<string> {
    const now = new Date();
    await this.closePendingRows(env.id, data.targetVersion);
    const [waiting] = await db
      .select({ id: projectAgentUpdates.id })
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, env.id),
          eq(projectAgentUpdates.targetVersion, data.targetVersion),
          eq(projectAgentUpdates.status, AgentUpdateStatus.Pending)
        )
      )
      .limit(1);
    if (waiting) {
      await db
        .update(projectAgentUpdates)
        .set({ status: AgentUpdateStatus.Running, startedAt: now, updatedAt: now })
        .where(eq(projectAgentUpdates.id, waiting.id));
      return waiting.id;
    }

    const updateId = crypto.randomUUID();
    await db.insert(projectAgentUpdates).values({
      id: updateId,
      projectId: env.projectId,
      projectEnvironmentId: env.id,
      agentId: env.agentId,
      fromVersion: await this.lastAppliedVersion(env.id, env.agentId),
      targetVersion: data.targetVersion,
      status: AgentUpdateStatus.Running,
      startedAt: now,
      updatedAt: now,
    });
    return updateId;
  }

  private async closePendingRows(projectEnvironmentId: string, keepTargetVersion?: string): Promise<void> {
    const now = new Date();
    await db
      .update(projectAgentUpdates)
      .set({ status: AgentUpdateStatus.Applied, finishedAt: now, updatedAt: now })
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId),
          eq(projectAgentUpdates.status, AgentUpdateStatus.Pending),
          ...(keepTargetVersion === undefined ? [] : [ne(projectAgentUpdates.targetVersion, keepTargetVersion)])
        )
      );
  }

  private async reconcileSkillsInline(
    env: ProjectEnvironmentContext,
    origin: string,
    holdingUpdateId: string
  ): Promise<void> {
    if (origin !== 'built_in') return;
    let outcome: SkillDeliveryOutcome;
    try {
      outcome = await this.skillDeliveries.reconcile(env.id, { holdingUpdateId });
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(`Post-job skill reconcile failed for environment ${env.id}: ${failure.message}`);
      await this.skillDeliveries.recordFailure({ projectEnvironmentId: env.id, attempt: 0 }, failure);
      return;
    }
    if (outcome.status !== 'converged') {
      this.logger.log(`Post-job skill reconcile for ${env.id} ${outcome.status}: ${outcome.reason}`);
    }
  }

  private async agentOf(agentId: string): Promise<{ name: string; origin: string } | undefined> {
    const [row] = await db
      .select({ name: agents.name, origin: agents.origin })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return row;
  }

  private async workspaceAtTarget(
    directory: string,
    packageName: string,
    targetVersion: string,
    origin: string
  ): Promise<boolean> {
    if (!directory) return false;
    const ledger = await this.readLedger(directory, packageName);
    if (ledger?.contentVersion !== targetVersion) return false;
    if (origin !== 'built_in') return true;
    const modelSelection = this.agentUpdateService.agentModelSelection(packageName);
    if (!modelSelection) return true;
    const config = await this.readWorkspaceOpenCodeConfig(directory);
    const expected = modelSelection.variant ? `${modelSelection.model}#${modelSelection.variant}` : modelSelection.model;
    return config?.model === expected && config?.agents?.[packageName]?.model === expected;
  }

  private async lastAppliedVersion(projectEnvironmentId: string, agentId: string): Promise<string | null> {
    const [row] = await db
      .select({ targetVersion: projectAgentUpdates.targetVersion })
      .from(projectAgentUpdates)
      .where(
        and(
          eq(projectAgentUpdates.projectEnvironmentId, projectEnvironmentId),
          eq(projectAgentUpdates.agentId, agentId),
          eq(projectAgentUpdates.status, AgentUpdateStatus.Applied)
        )
      )
      .orderBy(desc(projectAgentUpdates.createdAt))
      .limit(1);
    return row?.targetVersion ?? null;
  }

  private async recordOutcome(
    updateId: string,
    summary: AgentWorkspaceMigrationSummary,
    succeeded: boolean
  ): Promise<void> {
    const status = this.computeOutcomeStatus(summary, succeeded);
    const now = new Date();
    await db
      .update(projectAgentUpdates)
      .set({
        status,
        targetVersion: summary.targetVersion,
        appliedMigrations: summary.appliedMigrations,
        skippedMigrations: summary.skippedMigrations,
        conflicts: summary.conflicts,
        failedMigrations: summary.failedMigrations,
        requiresPodRecreate: summary.requiresPodRecreate,
        reloadStatus: status === AgentUpdateStatus.ReloadPending ? 'pending:queued' : null,
        error: summary.error ?? null,
        finishedAt: status === AgentUpdateStatus.ReloadPending ? null : now,
        updatedAt: now,
      })
      .where(eq(projectAgentUpdates.id, updateId));
  }

  private computeOutcomeStatus(
    summary: AgentWorkspaceMigrationSummary,
    succeeded: boolean
  ): (typeof AgentUpdateStatus)[keyof typeof AgentUpdateStatus] {
    if (!succeeded || summary.status === 'failed' || summary.failedMigrations.length > 0)
      return AgentUpdateStatus.Failed;
    if (summary.conflicts.length > 0) return AgentUpdateStatus.Conflict;
    if (summary.requiresPodRecreate) return AgentUpdateStatus.ReloadPending;
    return AgentUpdateStatus.Applied;
  }

  private needsDeferredReload(env: { podIp: string | null }, summary: AgentWorkspaceMigrationSummary): boolean {
    if (!env.podIp) return false;
    return summary.requiresPodRecreate;
  }

  private async readSummary(
    directory: string,
    packageName: string,
    logsFallback: string
  ): Promise<AgentWorkspaceMigrationSummary> {
    const summaryPath = path.join(
      this.storageMountPath,
      directory,
      '.opsiforce',
      'agents',
      `${packageName}.summary.json`
    );
    try {
      const raw = await readFile(summaryPath, 'utf8');
      const normalized = this.normalizeSummary(JSON.parse(raw) as RawSummary);
      await rm(summaryPath, { force: true });
      return normalized;
    } catch {
      return this.parseSummaryFromLogs(logsFallback);
    }
  }

  private async readLedger(directory: string, packageName: string): Promise<WorkspaceLedger | null> {
    const ledgerPath = path.join(this.storageMountPath, directory, '.opsiforce', 'agents', `${packageName}.json`);
    try {
      return JSON.parse(await readFile(ledgerPath, 'utf8')) as WorkspaceLedger;
    } catch {
      return null;
    }
  }

  private async readWorkspaceOpenCodeConfig(directory: string): Promise<{
    model?: string;
    agents?: Record<string, { model?: string } | undefined>;
  } | null> {
    const configPath = path.join(this.storageMountPath, directory, '.opencode', 'opencode.json');
    try {
      return JSON.parse(await readFile(configPath, 'utf8')) as {
        model?: string;
        agents?: Record<string, { model?: string } | undefined>;
      };
    } catch {
      return null;
    }
  }

  private parseSummaryFromLogs(logs: string): AgentWorkspaceMigrationSummary {
    const lines = logs
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .toReversed();
    for (const line of lines) {
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      const parsed = JSON.parse(line) as RawSummary;
      if (parsed.agentName && parsed.targetVersion && parsed.status) return this.normalizeSummary(parsed);
    }
    throw new Error('Agent update job did not return a migration summary');
  }

  private normalizeSummary(summary: RawSummary): AgentWorkspaceMigrationSummary {
    return {
      ...summary,
      appliedMigrations: asStrings(summary.appliedMigrations),
      skippedMigrations: asStrings(summary.skippedMigrations),
      failedMigrations: Array.isArray(summary.failedMigrations)
        ? (summary.failedMigrations as AgentWorkspaceMigrationSummary['failedMigrations'])
        : [],
      conflicts: Array.isArray(summary.conflicts)
        ? (summary.conflicts as AgentWorkspaceMigrationSummary['conflicts'])
        : [],
      ownedSkills: {
        written: asStrings(summary.ownedSkills?.written),
        removed: asStrings(summary.ownedSkills?.removed),
      },
      configChanged: summary.configChanged === true,
    };
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}
