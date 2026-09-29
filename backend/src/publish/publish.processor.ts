import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { projectPublishJobs, projectSchedules } from '../../db/schema';
import { GitService } from '../git/git.service';
import { PublishService } from './publish.service';
import { ProjectEventsService } from '../project/project-events.service';
import { PROJECT_PUBLISH_QUEUE, PublishJobData, PublishStatus } from './publish.types';
import { ProjectService } from '../project/project.service';
import { ProjectAuthService } from '../project/project-auth.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { GatewayKeyService } from '../gateway/gateway-key.service';
import { ScheduleService } from '../schedule/schedule.service';
import { AppReadinessService } from '../project/app-readiness.service';
import { PodStartupFailedError } from '../pod/pod.service';
import { writeJsonAtomic } from '../common/fs';
import { clearEnvJsonBackup, writeEnvJsonBackup } from '../common/env-file';
import { ExternalServicePublishService } from '../external-services';
import { DeliveryService } from '../delivery/delivery.service';
import { WorkspaceWriter } from '../delivery/workspace-writer';

const POD_READY_TIMEOUT_MS = 180 * 1000;
const APP_READY_TIMEOUT_MS = 10 * 60 * 1000;

@Processor(PROJECT_PUBLISH_QUEUE)
export class PublishProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishProcessor.name);
  private readonly storageMountPath: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly git: GitService,
    private readonly publishService: PublishService,
    private readonly projectService: ProjectService,
    private readonly projectAuthService: ProjectAuthService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly gatewayKeyService: GatewayKeyService,
    private readonly scheduleService: ScheduleService,
    private readonly appReadiness: AppReadinessService,
    private readonly projectEvents: ProjectEventsService,
    private readonly externalServicePublish: ExternalServicePublishService,
    private readonly deliveryService: DeliveryService,
    private readonly workspaceWriter: WorkspaceWriter
  ) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
  }

  async process(job: Job<PublishJobData>): Promise<void> {
    const data = job.data;
    let prodDir: string | null = null;
    let prodDirectory: string | null = null;
    let previousSha: string | null = null;
    let previousEnvVars: Record<string, string> | null = null;
    let deployStarted = false;
    let phase: PublishStatus = PublishStatus.Queued;

    const existing = await this.publishService.getJob(data.publishJobId).catch(() => null);
    if (!existing || existing.status === PublishStatus.Done || existing.status === PublishStatus.Failed) {
      this.logger.warn(`Skipping publish ${data.publishJobId}: already ${existing?.status ?? 'missing'}`);
      return;
    }

    try {
      phase = PublishStatus.Committing;
      await this.setStatus(data.publishJobId, PublishStatus.Committing, { startedAt: new Date() });

      const devEnv = await this.projectEnvironmentService.findDefaultByProjectId(data.projectId);
      const devDir = path.join(this.storageMountPath, devEnv.directory);
      const sha = await this.git.commitWorkingTree(devDir, `Publish ${data.environmentId}`);
      await this.setStatus(data.publishJobId, PublishStatus.Committing, { commitSha: sha });

      const prodEnv = await this.projectEnvironmentService.findById(data.projectEnvironmentId);
      prodDir = path.join(this.storageMountPath, prodEnv.directory);
      prodDirectory = prodEnv.directory;
      previousSha = prodEnv.deployedCommitSha;

      phase = PublishStatus.Swapping;
      await this.setStatus(data.publishJobId, PublishStatus.Swapping, { previousCommitSha: previousSha });
      await clearEnvJsonBackup(this.storageMountPath, prodEnv.directory);
      await this.projectService.beginPublishDeploy(data.projectEnvironmentId);
      deployStarted = true;

      if (data.isFirstPublish) {
        await rm(prodDir, { recursive: true, force: true });
        await this.git.cloneLocal(devDir, prodDir);
        await this.git.resetHard(prodDir, sha);
        await this.gatewayKeyService.createKey(data.projectId, data.projectEnvironmentId, data.tenantId);
      } else {
        await this.syncIncremental(devDir, prodDir, sha);
        previousEnvVars = await this.publishService.readEnvFile(prodEnv.directory);
        await writeEnvJsonBackup(this.storageMountPath, prodEnv.directory, previousEnvVars);
      }

      if (!(await this.workspaceWriter.hasOpencodeDir(prodEnv.directory))) {
        await this.deliveryService.copyToNewEnvironment(devEnv.id, data.projectEnvironmentId);
      }

      await this.writeEnvFile(prodEnv.directory, data.variables, data.isFirstPublish);

      if (data.isFirstPublish && devEnv.authMode !== 'public') {
        const managedFallbackTenantName =
          devEnv.authMode === 'managed' ? await this.projectService.findExternalTenantName(data.tenantId) : undefined;
        await this.projectAuthService.inheritAuth(
          devEnv.id,
          data.projectEnvironmentId,
          prodEnv.environmentSlug,
          managedFallbackTenantName
        );
      }

      phase = PublishStatus.Building;
      await this.setStatus(data.publishJobId, PublishStatus.Building);
      const podIp = await this.projectService.recreatePodForDeploy(data.projectEnvironmentId, POD_READY_TIMEOUT_MS);

      phase = PublishStatus.Migrating;
      await this.setStatus(data.publishJobId, PublishStatus.Migrating);
      const appReady = await this.appReadiness.awaitReady(data.projectEnvironmentId, APP_READY_TIMEOUT_MS);
      if (!appReady) {
        throw new Error('Production app did not become ready within the deploy window');
      }

      await this.externalServicePublish.carryInboundWiring(devEnv.id, data.projectEnvironmentId);

      try {
        await this.reconcileSchedules(data.projectId, data.projectEnvironmentId, data.tenantId, data.scheduleIds);
      } catch (scheduleErr) {
        this.logger.warn(
          `Schedule reconcile for ${data.projectEnvironmentId} failed after a healthy publish: ${(scheduleErr as Error).message}`
        );
      }

      await this.projectService.finishPublishDeploy(data.projectEnvironmentId, podIp, sha);
      await clearEnvJsonBackup(this.storageMountPath, prodEnv.directory).catch(() => undefined);
      await this.setStatus(data.publishJobId, PublishStatus.Done, { completedAt: new Date() });
      this.logger.log(
        `Published ${data.projectId} to environment ${data.environmentId} (${data.projectEnvironmentId})`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Publish ${data.publishJobId} failed: ${message}`);

      if (!data.isFirstPublish && prodDir && prodDirectory && previousSha) {
        try {
          await this.git.resetHard(prodDir, previousSha);
          if (previousEnvVars) {
            await this.restoreEnvFile(prodDir, previousEnvVars);
          }
          if (deployStarted) {
            const rolledBackIp = await this.projectService.recreatePodForDeploy(
              data.projectEnvironmentId,
              POD_READY_TIMEOUT_MS
            );
            await this.projectService.finishPublishDeploy(data.projectEnvironmentId, rolledBackIp, previousSha);
          }
          await clearEnvJsonBackup(this.storageMountPath, prodDirectory).catch(() => undefined);
        } catch (rollbackErr) {
          this.logger.warn(
            `Rollback of ${data.projectEnvironmentId} to ${previousSha} failed: ${(rollbackErr as Error).message}`
          );
          if (deployStarted) {
            await this.projectService.failPublishDeploy(data.projectEnvironmentId).catch(() => undefined);
          }
        }
      } else if (data.isFirstPublish) {
        await this.projectService.failPublishDeploy(data.projectEnvironmentId).catch((patchErr) => {
          this.logger.warn(
            `Failed to mark environment ${data.projectEnvironmentId} as failed: ${(patchErr as Error).message}`
          );
        });
      }

      await this.setStatus(data.publishJobId, PublishStatus.Failed, {
        error: userFacingPublishError(err, phase),
        completedAt: new Date(),
      });
    }
  }

  private async syncIncremental(devDir: string, prodDir: string, sha: string): Promise<void> {
    if (await this.git.isRepo(prodDir)) {
      try {
        await this.git.fetchOrigin(prodDir);
        await this.git.resetHard(prodDir, sha);
        return;
      } catch (err) {
        this.logger.warn(
          `Incremental sync of ${prodDir} failed, rebuilding its git directory: ${(err as Error).message}`
        );
      }
    } else {
      this.logger.warn(`Unhealthy git repository at ${prodDir}, rebuilding its git directory`);
    }
    await this.rebuildGitDir(devDir, prodDir);
    await this.git.resetHard(prodDir, sha);
  }

  private async rebuildGitDir(devDir: string, prodDir: string): Promise<void> {
    const cloneDir = path.join(path.dirname(prodDir), `.${path.basename(prodDir)}.git-rebuild`);
    await rm(cloneDir, { recursive: true, force: true });
    await this.git.cloneNoCheckout(devDir, cloneDir);
    await rm(path.join(prodDir, '.git'), { recursive: true, force: true });
    await mkdir(prodDir, { recursive: true });
    await rename(path.join(cloneDir, '.git'), path.join(prodDir, '.git'));
    await rm(cloneDir, { recursive: true, force: true });
  }

  private async reconcileSchedules(
    projectId: string,
    projectEnvironmentId: string,
    tenantId: string,
    scheduleIds: string[]
  ): Promise<void> {
    const devSchedules =
      scheduleIds.length === 0
        ? []
        : await db
            .select()
            .from(projectSchedules)
            .where(
              and(
                eq(
                  projectSchedules.projectEnvironmentId,
                  this.projectEnvironmentService.defaultEnvironmentId(projectId)
                ),
                inArray(projectSchedules.id, scheduleIds)
              )
            );

    for (const schedule of devSchedules) {
      const headers = isStringRecord(schedule.headers) ? schedule.headers : undefined;
      await this.scheduleService.upsert(projectId, projectEnvironmentId, tenantId, {
        name: schedule.name,
        cronPattern: schedule.cronPattern,
        targetPath: schedule.targetPath,
        method: schedule.method,
        body: schedule.body ?? undefined,
        headers,
        isActive: schedule.isActive,
      });
    }

    const desiredNames = new Set(devSchedules.map((schedule) => schedule.name));
    const existing = await this.scheduleService.findByEnvironment(projectEnvironmentId);
    for (const current of existing) {
      if (!desiredNames.has(current.name)) {
        await this.scheduleService.removeByEnvironment(projectEnvironmentId, current.id);
      }
    }
  }

  private async writeEnvFile(
    directory: string,
    variables: Record<string, string>,
    isFirstPublish: boolean
  ): Promise<void> {
    const existing = isFirstPublish ? {} : await this.publishService.readEnvFile(directory);
    const merged = { ...existing, ...variables };
    const target = path.join(this.storageMountPath, directory, 'app', 'opsiforce.env.json');
    await writeJsonAtomic(target, merged);
  }

  private async restoreEnvFile(prodDir: string, variables: Record<string, string>): Promise<void> {
    const target = path.join(prodDir, 'app', 'opsiforce.env.json');
    await writeJsonAtomic(target, variables);
  }

  private async setStatus(
    jobId: string,
    status: PublishStatus,
    extra?: Partial<typeof projectPublishJobs.$inferInsert>
  ): Promise<void> {
    const [row] = await db
      .update(projectPublishJobs)
      .set({ status, ...extra, updatedAt: new Date() })
      .where(eq(projectPublishJobs.id, jobId))
      .returning();
    if (row) await this.projectEvents.publish(row.projectId);
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

const PHASE_FAILURE_MESSAGE: Partial<Record<PublishStatus, string>> = {
  [PublishStatus.Committing]: "Couldn't save the latest changes from Development. Please try again.",
  [PublishStatus.Swapping]: "Couldn't prepare the new version of your app. Please try again.",
  [PublishStatus.Building]: "The app couldn't start. Please try again in a few minutes.",
  [PublishStatus.Migrating]: "The app started but didn't come online in time. Please try again.",
};

function userFacingPublishError(err: unknown, phase: PublishStatus): string {
  if (err instanceof PodStartupFailedError) {
    if (err.reason === 'Unschedulable') {
      return 'Not enough capacity to start the app right now. Please try again in a few minutes.';
    }
    if (err.reason === 'ImagePullBackOff') {
      return "The app image couldn't be loaded. Please try again in a few minutes.";
    }
    return 'The app failed to start. Please try again.';
  }

  const message = err instanceof Error ? err.message : String(err);
  if (/not ready after \d+ms/i.test(message)) {
    return 'The app took too long to start. Please try again in a few minutes.';
  }
  if (message.includes('did not become ready within the deploy window')) {
    return "The app started but didn't come online in time. Please try again.";
  }
  if (message.includes('Carrying external-service wiring failed')) {
    return 'The app deployed, but copying its external-service wiring failed. Please publish again.';
  }
  if (message.includes('No active LLM virtual keys')) {
    return 'This environment is missing its LLM credentials. Please reconfigure it and try again.';
  }

  return PHASE_FAILURE_MESSAGE[phase] ?? 'Publishing failed unexpectedly. Please try again.';
}
