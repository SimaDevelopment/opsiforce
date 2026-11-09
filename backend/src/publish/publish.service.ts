import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import crypto from 'crypto';
import path from 'node:path';
import { db } from '../../db';
import { projectDuplicateJobs, projectEnvironments, projectPublishJobs, projectSchedules } from '../../db/schema';
import { readEnvJson } from '../common/env-file';
import { ProjectConfigurationCarry } from '../external-services';
import { ProjectService } from '../project/project.service';
import { lockProjectGit, type DbExecutor } from '../common/locks';
import { EnvironmentService } from '../environment/environment.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import { PublicUrlService } from '../project-environment/public-url.service';
import { ProjectStatus } from '../project/project.types';
import { ACTIVE_DUPLICATE_STATUSES } from '../project/project-duplicate.types';
import {
  ACTIVE_PUBLISH_STATUSES,
  PROJECT_PUBLISH_QUEUE,
  PublishDto,
  PublishFormResponse,
  PublishJobData,
  PublishJobResponse,
  PublishReportLine,
  PublishStatus,
  PublishTarget,
} from './publish.types';
import { holdsAppData } from './app-data';
import { PublishCancellations } from './publish-cancellations';
import { ProjectEventsService } from '../project/project-events.service';

const PUBLISH_IN_PROGRESS =
  'A publish is already in progress for this environment. To publish again now, open its progress card and cancel it.';

@Injectable()
export class PublishService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PublishService.name);
  private readonly storageMountPath: string;
  private readonly platformVersion: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly environmentService: EnvironmentService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly publicUrls: PublicUrlService,
    private readonly projectService: ProjectService,
    private readonly projectConfigurationCarry: ProjectConfigurationCarry,
    private readonly projectEvents: ProjectEventsService,
    private readonly cancellations: PublishCancellations,
    @InjectQueue(PROJECT_PUBLISH_QUEUE)
    private readonly queue: Queue<PublishJobData>
  ) {
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.platformVersion = this.configService.get<string>('platformVersion', '0.1.0');
  }

  async onApplicationBootstrap(): Promise<void> {
    const alreadyDeployed = await db
      .select({ id: projectPublishJobs.id })
      .from(projectPublishJobs)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projectPublishJobs.projectEnvironmentId))
      .where(
        and(
          eq(projectPublishJobs.status, PublishStatus.Migrating),
          eq(projectEnvironments.status, ProjectStatus.Active),
          eq(projectEnvironments.deployedCommitSha, projectPublishJobs.commitSha)
        )
      );
    if (alreadyDeployed.length > 0) {
      await db
        .update(projectPublishJobs)
        .set({ status: PublishStatus.Done, completedAt: new Date(), updatedAt: new Date() })
        .where(
          inArray(
            projectPublishJobs.id,
            alreadyDeployed.map((row) => row.id)
          )
        );
      this.logger.warn(
        `Marked ${alreadyDeployed.length} interrupted publish job(s) as done on startup: their deploys had already completed`
      );
    }

    const stranded = await db
      .update(projectPublishJobs)
      .set({
        status: PublishStatus.Failed,
        error: 'Publish interrupted by a server restart',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(projectPublishJobs.status, ACTIVE_PUBLISH_STATUSES))
      .returning({ id: projectPublishJobs.id });
    if (stranded.length > 0) {
      this.logger.warn(`Marked ${stranded.length} interrupted publish job(s) as failed on startup`);
    }
  }

  async listTargets(projectId: string, tenantId: string): Promise<PublishTarget[]> {
    const registry = (await this.environmentService.listForTenant(tenantId)).filter((env) => !env.isDefault);
    const instances = await this.projectEnvironmentService.listByProjectId(projectId);

    return registry.map((env) => {
      const instance = instances.find((i) => i.environmentId === env.id);
      return {
        environmentId: env.id,
        name: env.name,
        slug: env.slug,
        description: env.description,
        projectEnvironmentId: instance?.id ?? null,
        status: instance ? instance.status : null,
        deployedCommitSha: instance?.deployedCommitSha ?? null,
      };
    });
  }

  async getForm(projectId: string, tenantId: string, environmentId: string): Promise<PublishFormResponse> {
    const registryEnv = await this.environmentService.findForTenant(tenantId, environmentId);
    if (registryEnv.isDefault) {
      throw new BadRequestException('Cannot publish to the Development environment');
    }

    const devEnv = await this.projectEnvironmentService.findDefaultByProjectId(projectId);
    const instances = await this.projectEnvironmentService.listByProjectId(projectId);
    const instance = instances.find((i) => i.environmentId === environmentId);
    const isFirstPublish = !instance || instance.deployedCommitSha === null;

    const devVars = await this.readEnvFile(devEnv.directory);
    const prodVars = instance ? await this.readEnvFile(instance.directory) : {};

    const variables = Object.keys(devVars).map((key) => {
      const existsInTarget = !!instance && key in prodVars;
      return {
        key,
        value: existsInTarget ? prodVars[key] : devVars[key],
        devValue: devVars[key],
        isNew: !existsInTarget,
      };
    });

    const devSchedules = await db
      .select({ id: projectSchedules.id, name: projectSchedules.name })
      .from(projectSchedules)
      .where(eq(projectSchedules.projectEnvironmentId, this.projectEnvironmentService.defaultEnvironmentId(projectId)));

    const schedules = devSchedules.map((s) => ({ id: s.id, name: s.name, selected: true }));

    const services = (await this.projectConfigurationCarry.choices(devEnv.id, instance?.id ?? null)).map((choice) => ({
      id: choice.id,
      name: choice.name,
      targetHasOwn: choice.targetHasOwn,
      selected: !choice.targetHasOwn,
    }));

    return {
      environmentId,
      environmentName: registryEnv.name,
      isFirstPublish,
      developmentHasData: await holdsAppData(this.workspacePath(devEnv.directory)),
      variables,
      schedules,
      services,
    };
  }

  async publish(projectId: string, tenantId: string, dto: PublishDto): Promise<PublishJobResponse> {
    if (!dto || typeof dto.environmentId !== 'string') {
      throw new BadRequestException("'environmentId' is required");
    }

    const registryEnv = await this.environmentService.findForTenant(tenantId, dto.environmentId);
    if (registryEnv.isDefault) {
      throw new BadRequestException('Cannot publish to the Development environment');
    }

    if (await this.hasActiveJob(projectId, dto.environmentId)) {
      throw new ConflictException(PUBLISH_IN_PROGRESS);
    }

    if (await this.hasActiveDuplicate(projectId)) {
      throw new ConflictException('Cannot publish while a duplicate is in progress for this project');
    }

    if (dto.withData) await this.assertDataCanMove(projectId);

    const instances = await this.projectEnvironmentService.listByProjectId(projectId);
    const existing = instances.find((i) => i.environmentId === dto.environmentId);
    const isFirstPublish = !existing || existing.deployedCommitSha === null;
    const projectEnvironmentId = existing?.id ?? crypto.randomUUID();

    if (!existing) {
      const devEnv = await this.projectEnvironmentService.findDefaultByProjectId(projectId);
      try {
        await this.projectEnvironmentService.create({
          id: projectEnvironmentId,
          projectId,
          environmentId: dto.environmentId,
          isDefault: false,
          directory: `projects/${projectEnvironmentId}`,
          platformVersion: this.platformVersion,
          status: ProjectStatus.Publishing,
          authMode: devEnv.authMode,
          signInProviderId: devEnv.signInProviderId,
        });
      } catch (err) {
        if (isProjectEnvironmentConflict(err)) {
          throw new ConflictException(PUBLISH_IN_PROGRESS);
        }
        throw err;
      }
    }

    const publishJobId = crypto.randomUUID();
    try {
      await db.transaction(async (tx) => {
        await lockProjectGit(tx, projectId);
        if (await this.hasActiveDuplicate(projectId, tx)) {
          throw new ConflictException('Cannot publish while a duplicate is in progress for this project');
        }
        await tx.insert(projectPublishJobs).values({
          id: publishJobId,
          projectId,
          projectEnvironmentId,
          environmentId: dto.environmentId,
          tenantId,
          status: PublishStatus.Queued,
        });
      });
    } catch (err) {
      if (isActivePublishConflict(err)) {
        throw new ConflictException(PUBLISH_IN_PROGRESS);
      }
      throw err;
    }

    try {
      await this.queue.add(
        'publish',
        {
          publishJobId,
          projectId,
          projectEnvironmentId,
          environmentId: dto.environmentId,
          tenantId,
          isFirstPublish,
          variables: dto.variables ?? {},
          scheduleIds: dto.scheduleIds ?? [],
          serviceIds: dto.serviceIds ?? null,
          withData: dto.withData === true,
        },
        { jobId: publishJobId, attempts: 1, removeOnComplete: true, removeOnFail: 1000 }
      );
    } catch (err) {
      await this.abandonJob(publishJobId, existing ? null : projectEnvironmentId);
      throw err;
    }

    return this.toJobResponse(publishJobId);
  }

  private async assertDataCanMove(projectId: string): Promise<void> {
    const devEnv = await this.projectEnvironmentService.findDefaultByProjectId(projectId);
    if (!(await holdsAppData(this.workspacePath(devEnv.directory)))) {
      throw new BadRequestException({ code: 'no-development-data', message: 'Development has no data to copy' });
    }
    await this.projectService.assertCanHoldForDataCopy(devEnv.id);
  }

  private workspacePath(directory: string): string {
    return path.join(this.storageMountPath, directory);
  }

  private async abandonJob(jobId: string, createdEnvironmentId: string | null): Promise<void> {
    await db
      .update(projectPublishJobs)
      .set({
        status: PublishStatus.Failed,
        error: 'Failed to enqueue publish job',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectPublishJobs.id, jobId))
      .catch((err) => {
        this.logger.warn(`Failed to abandon publish job ${jobId}: ${(err as Error).message}`);
      });
    if (createdEnvironmentId) {
      await this.projectEnvironmentService
        .patch(createdEnvironmentId, { status: ProjectStatus.Failed })
        .catch(() => undefined);
    }
  }

  async cancel(projectId: string, environmentId: string): Promise<PublishJobResponse> {
    const job = await this.activeJob(projectId, environmentId);
    if (!job) throw new ConflictException('No publish is in progress for this environment');
    if (job.status === PublishStatus.Queued) {
      const [dropped] = await db
        .update(projectPublishJobs)
        .set({
          status: PublishStatus.Failed,
          error: 'Publish cancelled.',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(projectPublishJobs.id, job.id), eq(projectPublishJobs.status, PublishStatus.Queued)))
        .returning({ id: projectPublishJobs.id });
      if (dropped) {
        await this.projectService.failPublishDeploy(job.projectEnvironmentId);
        await this.projectEvents.publish(projectId);
        return this.toJobResponse(job.id);
      }
    }
    if (!this.cancellations.cancel(job.id)) {
      throw new ConflictException("This publish can't be cancelled at this step");
    }
    return this.toJobResponse(job.id);
  }

  private async hasActiveJob(projectId: string, environmentId: string): Promise<boolean> {
    return (await this.activeJob(projectId, environmentId)) !== null;
  }

  private async activeJob(projectId: string, environmentId: string) {
    const [row] = await db
      .select({
        id: projectPublishJobs.id,
        status: projectPublishJobs.status,
        projectEnvironmentId: projectPublishJobs.projectEnvironmentId,
      })
      .from(projectPublishJobs)
      .where(
        and(
          eq(projectPublishJobs.projectId, projectId),
          eq(projectPublishJobs.environmentId, environmentId),
          inArray(projectPublishJobs.status, ACTIVE_PUBLISH_STATUSES)
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async hasActiveDuplicate(projectId: string, executor: DbExecutor = db): Promise<boolean> {
    const [row] = await executor
      .select({ id: projectDuplicateJobs.id })
      .from(projectDuplicateJobs)
      .where(
        and(
          or(eq(projectDuplicateJobs.sourceProjectId, projectId), eq(projectDuplicateJobs.targetProjectId, projectId)),
          inArray(projectDuplicateJobs.status, ACTIVE_DUPLICATE_STATUSES)
        )
      )
      .limit(1);
    return !!row;
  }

  async getLatestJob(projectId: string, environmentId: string): Promise<PublishJobResponse | null> {
    const [row] = await db
      .select()
      .from(projectPublishJobs)
      .where(and(eq(projectPublishJobs.projectId, projectId), eq(projectPublishJobs.environmentId, environmentId)))
      .orderBy(desc(projectPublishJobs.createdAt))
      .limit(1);
    return row ? this.toResponse(row) : null;
  }

  async claim(jobId: string): Promise<boolean> {
    const [claimed] = await db
      .update(projectPublishJobs)
      .set({ status: PublishStatus.Committing, startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(projectPublishJobs.id, jobId), eq(projectPublishJobs.status, PublishStatus.Queued)))
      .returning({ projectId: projectPublishJobs.projectId });
    if (claimed) await this.projectEvents.publish(claimed.projectId);
    return !!claimed;
  }

  private async toJobResponse(jobId: string): Promise<PublishJobResponse> {
    const [row] = await db.select().from(projectPublishJobs).where(eq(projectPublishJobs.id, jobId));
    if (!row) throw new NotFoundException(`Publish job ${jobId} not found`);
    return this.toResponse(row);
  }

  private async toResponse(row: typeof projectPublishJobs.$inferSelect): Promise<PublishJobResponse> {
    const env = await this.projectEnvironmentService.findByIdOrNull(row.projectEnvironmentId);
    return {
      id: row.id,
      projectEnvironmentId: row.projectEnvironmentId,
      environmentId: row.environmentId,
      status: row.status as PublishStatus,
      commitSha: row.commitSha,
      error: row.error,
      report: row.report as PublishReportLine[],
      publicUrl: env && this.publicUrls.publicUrlOnceLive(env),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async readEnvFile(directory: string): Promise<Record<string, string>> {
    return readEnvJson(this.storageMountPath, directory);
  }
}

interface PostgresErrorFields {
  code?: string;
  constraint_name?: string;
}

function postgresError(err: unknown): PostgresErrorFields {
  const direct = err as PostgresErrorFields & { cause?: unknown };
  if (direct?.code) return direct;
  return (direct?.cause as PostgresErrorFields | undefined) ?? {};
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = postgresError(err);
  return pg.code === '23505' && pg.constraint_name === constraint;
}

function isActivePublishConflict(err: unknown): boolean {
  return isUniqueViolation(err, 'uq_project_publish_jobs_one_active');
}

function isProjectEnvironmentConflict(err: unknown): boolean {
  return isUniqueViolation(err, 'project_environments_project_id_environment_id_unique');
}
