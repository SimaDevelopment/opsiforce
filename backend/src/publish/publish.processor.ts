import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Job } from 'bullmq';
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { projectPublishJobs, projectSchedules } from '../../db/schema';
import { GitService } from '../git/git.service';
import { PublishService } from './publish.service';
import { ProjectEventsService } from '../project/project-events.service';
import { PROJECT_PUBLISH_QUEUE, PublishJobData, PublishReportLine, PublishStatus } from './publish.types';
import { ProjectService } from '../project/project.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { GatewayKeyService } from '../gateway/gateway-key.service';
import { ScheduleService } from '../schedule/schedule.service';
import { AppReadinessService } from '../project/app-readiness.service';
import { PodStartupFailedError } from '../pod/pod.service';
import { writeJsonAtomic } from '../common/fs';
import { clearEnvJsonBackup, writeEnvJsonBackup } from '../common/env-file';
import { ProjectConfigurationCarry, ServiceDefaultEnvironments } from '../external-services';
import { DeliveryService } from '../delivery/delivery.service';
import { EnvironmentSkillsService } from '../delivery/environment-skills';
import { WorkspaceWriter } from '../delivery/workspace-writer';
import { CHAT_FILE_FOLDERS } from '../delivery/platform-ignores';
import {
  discardReplacedAppData,
  holdsAppData,
  holdsReplacedAppData,
  replaceAppData,
  restoreReplacedAppData,
  settleReplacedAppData,
} from './app-data';
import { publishJobDone } from './publish-job-done';
import { keepingAppDetails } from './app-details-file';
import { PublishCancellations, PublishCancelledError, unlessCancelled } from './publish-cancellations';

const POD_READY_TIMEOUT_MS = 180 * 1000;
const APP_READY_TIMEOUT_MS = 10 * 60 * 1000;
const CONCURRENT_PUBLISHES = 4;
const BUSY_PROJECT_RETRY_MS = 5000;

@Processor(PROJECT_PUBLISH_QUEUE, { concurrency: CONCURRENT_PUBLISHES })
export class PublishProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishProcessor.name);
  private readonly storageMountPath: string;
  private readonly busyProjects = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly git: GitService,
    private readonly publishService: PublishService,
    private readonly projectService: ProjectService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly gatewayKeyService: GatewayKeyService,
    private readonly scheduleService: ScheduleService,
    private readonly appReadiness: AppReadinessService,
    private readonly projectEvents: ProjectEventsService,
    private readonly projectConfigurationCarry: ProjectConfigurationCarry,
    private readonly serviceDefaults: ServiceDefaultEnvironments,
    private readonly deliveryService: DeliveryService,
    private readonly workspaceWriter: WorkspaceWriter,
    private readonly environmentSkills: EnvironmentSkillsService,
    private readonly cancellations: PublishCancellations
  ) {
    super();
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
  }

  async process(job: Job<PublishJobData>, token?: string): Promise<void> {
    const { projectId } = job.data;
    if (this.busyProjects.has(projectId)) {
      await job.moveToDelayed(Date.now() + BUSY_PROJECT_RETRY_MS, token);
      throw new DelayedError();
    }
    this.busyProjects.add(projectId);
    try {
      await this.publish(job.data);
    } finally {
      this.busyProjects.delete(projectId);
    }
  }

  private async publish(data: PublishJobData): Promise<void> {
    let prodDir: string | null = null;
    let prodDirectory: string | null = null;
    let previousSha: string | null = null;
    let previousEnvVars: Record<string, string> | null = null;
    let deployStarted = false;
    let appDataReplaced = false;
    let phase: PublishStatus = PublishStatus.Queued;

    if (!(await this.publishService.claim(data.publishJobId))) {
      this.logger.warn(`Skipping publish ${data.publishJobId}: it is no longer queued`);
      return;
    }

    try {
      phase = PublishStatus.Committing;

      const devEnv = await this.projectEnvironmentService.findDefaultByProjectId(data.projectId);
      const devDir = path.join(this.storageMountPath, devEnv.directory);
      await this.workspaceWriter.keepPlatformIgnores(devEnv.directory);
      await this.git.untrack(devDir, CHAT_FILE_FOLDERS);
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
        const targetDir = prodDir;
        await keepingAppDetails(targetDir, () => this.syncIncremental(devDir, targetDir, sha));
        previousEnvVars = await this.publishService.readEnvFile(prodEnv.directory);
        await writeEnvJsonBackup(this.storageMountPath, prodEnv.directory, previousEnvVars);
      }

      const leftoverAppData = await holdsReplacedAppData(prodDir);
      if (data.withData || leftoverAppData) await this.projectService.stopPodForDeploy(data.projectEnvironmentId);
      if (leftoverAppData) await settleReplacedAppData(prodDir, publishJobDone);

      if (data.withData) {
        const targetDir = prodDir;
        await this.projectService.whileHeldForDataCopy(devEnv.id, async () => {
          if (!(await holdsAppData(devDir))) {
            throw new ConflictException({ code: 'no-development-data', message: 'Development has no data to copy' });
          }
          appDataReplaced = true;
          await replaceAppData(devDir, targetDir, data.publishJobId, publishJobDone);
        });
      }

      if (!(await this.workspaceWriter.hasOpencodeDir(prodEnv.directory))) {
        await this.deliveryService.copyToNewEnvironment(devEnv.id, data.projectEnvironmentId);
      }

      await this.writeEnvFile(prodEnv.directory, data.variables, data.isFirstPublish);

      if (data.isFirstPublish) {
        await this.projectService.inheritAuth(devEnv, prodEnv);
      }

      phase = PublishStatus.Building;
      const cancelled = this.cancellations.begin(data.publishJobId);
      let appReady: boolean;
      try {
        await this.setStatus(data.publishJobId, PublishStatus.Building);
        await this.projectService.recreatePodForDeploy(data.projectEnvironmentId, POD_READY_TIMEOUT_MS);

        phase = PublishStatus.Migrating;
        await this.setStatus(data.publishJobId, PublishStatus.Migrating);
        appReady = await unlessCancelled(
          cancelled,
          this.appReadiness.awaitReady(data.projectEnvironmentId, APP_READY_TIMEOUT_MS)
        );
      } finally {
        this.cancellations.end(data.publishJobId);
      }
      if (!appReady) {
        throw new Error('Production app did not become ready within the deploy window');
      }

      const report: PublishReportLine[] = [
        ...(appDataReplaced ? [{ kind: 'app-data', outcome: 'replaced' } as const] : []),
        ...(await this.projectConfigurationCarry.carry(devEnv.id, data.projectEnvironmentId, data.serviceIds)),
        ...(await this.environmentSkills.carry(devEnv.id, data.projectEnvironmentId)),
      ];
      await this.setStatus(data.publishJobId, PublishStatus.Migrating, { report });

      try {
        await this.reconcileSchedules(data.projectId, data.projectEnvironmentId, data.tenantId, data.scheduleIds);
      } catch (scheduleErr) {
        this.logger.warn(
          `Schedule reconcile for ${data.projectEnvironmentId} failed after a healthy publish: ${(scheduleErr as Error).message}`
        );
      }

      await this.projectService.finishPublishDeploy(data.projectEnvironmentId, sha);
      await this.serviceDefaults.publishedTo(data.projectId, data.projectEnvironmentId).catch((defaultErr) => {
        this.logger.error(
          `Setting the External Service Default environment after publishing ${data.projectEnvironmentId} failed: ${(defaultErr as Error).message}`
        );
      });
      await clearEnvJsonBackup(this.storageMountPath, prodEnv.directory).catch(() => undefined);
      await this.setStatus(data.publishJobId, PublishStatus.Done, { completedAt: new Date() });
      if (appDataReplaced) await discardReplacedAppData(prodDir, data.publishJobId).catch(() => undefined);
      this.logger.log(
        `Published ${data.projectId} to environment ${data.environmentId} (${data.projectEnvironmentId})`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Publish ${data.publishJobId} failed: ${message}`);

      if (!data.isFirstPublish && prodDir && prodDirectory && previousSha) {
        try {
          if (appDataReplaced) {
            await this.projectService.stopPodForDeploy(data.projectEnvironmentId);
            await restoreReplacedAppData(prodDir, data.publishJobId);
          }
          const targetDir = prodDir;
          const restoredSha = previousSha;
          await keepingAppDetails(targetDir, () => this.git.resetHard(targetDir, restoredSha));
          if (previousEnvVars) {
            await this.restoreEnvFile(prodDir, previousEnvVars);
          }
          if (deployStarted) {
            await this.projectService.recreatePodForDeploy(data.projectEnvironmentId, POD_READY_TIMEOUT_MS);
            await this.projectService.finishPublishDeploy(data.projectEnvironmentId, previousSha);
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
  if (err instanceof PublishCancelledError) return 'Publish cancelled.';
  if (err instanceof ConflictException) {
    const refusal = err.getResponse();
    if (typeof refusal === 'object' && 'message' in refusal && typeof refusal.message === 'string')
      return refusal.message;
  }
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
  if (message.includes('No active LLM virtual keys')) {
    return 'This environment is missing its LLM credentials. Please reconfigure it and try again.';
  }

  return PHASE_FAILURE_MESSAGE[phase] ?? 'Publishing failed unexpectedly. Please try again.';
}
