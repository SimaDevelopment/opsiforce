import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  Inject,
  forwardRef,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { V1Pod } from '@kubernetes/client-node';
import { eq, and, desc, asc, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Queue } from 'bullmq';
import crypto from 'crypto';
import path from 'path';
import { rm } from 'node:fs/promises';
import { db } from '../../db';
import {
  projectSettings,
  projectPodSettings,
  projects,
  projectApps,
  projectEnvironments,
  projectPublishJobs,
  projectSchedules,
  workspaceMembers,
  workspaces,
  tenants,
  tenantSettings,
  projectDuplicateJobs,
  projectTransferJobs,
} from '../../db/schema';
import { accessibleProjectsFilter, isHiddenProjectReachable, visibleProjectsFilter } from './project-visibility';
import { PodService, PodStartupFailedError } from '../pod/pod.service';
import { PodCacheService } from '../pod/pod.cache.service';
import { ProxyService } from '../proxy/proxy.service';
import { ProjectPoolService } from '../pool/project-pool.service';
import { TimeoutService } from '../timeout/timeout.service';
import { BifrostService } from '../bifrost/bifrost.service';
import { assertIdleTimeoutMs } from '../common/validation';
import { restoreEnvJsonBackup } from '../common/env-file';
import { writeJsonAtomic } from '../common/fs';
import { lockProjectGit, type DbExecutor } from '../common/locks';
import { DefaultsService } from '../defaults/defaults.service';
import { GatewayKeyService } from '../gateway/gateway-key.service';
import { ScheduleService } from '../schedule/schedule.service';
import { AgentService } from '../agent/agent.service';
import { EnvironmentService } from '../environment/environment.service';
import { ExternalServiceProvisioningService } from '../external-services';
import { GitService } from '../git/git.service';
import { ProjectEnvironmentService } from '../project-environment/project-environment.service';
import type { ProjectEnvironmentContext } from '../project-environment/project-environment.types';
import type {
  ExportManifestAppDetails,
  ExportManifestResources,
  ExportManifestSchedule,
  ExportManifestSettings,
  JsonValue,
} from '../export/project-export.types';
import {
  CreateProjectDto,
  UpdateProjectDto,
  DuplicateProjectDto,
  ProjectResponse,
  ProjectCreationContext,
  ProjectEnvironmentSummary,
  ProjectStatus,
  ProjectState,
  ProjectAuthResponse,
  UpdateProjectAuthDto,
  UpdateAppDto,
  UpdateProjectPodClassDto,
  UpdateProjectLoggingDto,
  ProjectLoggingResponse,
  RequestLogMode,
  REQUEST_LOG_BODY_LIMIT_MAX,
  TEST_PROJECT_KIND,
  isChatKind,
  availableAuthModes,
} from './project.types';
import { MAX_PROJECT_CHAIN_DEPTH } from './project.constants';
import {
  buildPodClassCatalog,
  clampCustom,
  isPreset,
  resolvePreset,
  toK8sResources,
  type K8sResourceRequirements,
  type PodClass,
  type PodClassCatalog,
  type PodResources,
} from '../pod/pod-classes';

const APP_NAME_MIN_LENGTH = 1;
const APP_NAME_MAX_LENGTH = 80;
const APP_DESCRIPTION_MAX_LENGTH = 500;
const CRASH_LOOP_RECREATE_AGE_MS = 60 * 1000;
const UNSCHEDULABLE_STARTUP_GRACE_MS = 180 * 1000;
const STARTUP_RETRY_BASE_MS = 5 * 1000;
const STARTUP_RETRY_MAX_MS = 5 * 60 * 1000;
const DUPLICATE_APP_READY_TIMEOUT_MS = 5 * 60 * 1000;
const APP_SERVING_PROBE_TIMEOUT_MS = 3 * 1000;

interface AppMetaPatch {
  name?: string;
  description?: string | null;
}

function environmentIdFromPodLabels(pod: V1Pod): string | null {
  return (
    pod.metadata?.labels?.['opsiforce.io/environment-id'] ?? pod.metadata?.labels?.['opsiforce.io/project-id'] ?? null
  );
}

function validateUpdateAppDto(body: UpdateAppDto): AppMetaPatch {
  const patch: AppMetaPatch = {};

  if ('name' in body) patch.name = validateAppName(body.name);
  if ('description' in body) patch.description = validateAppDescription(body.description);

  if (!('name' in patch) && !('description' in patch)) {
    throw new BadRequestException("At least one of 'name' or 'description' must be provided");
  }

  return patch;
}

function validateAppName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException("'name' must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length < APP_NAME_MIN_LENGTH || trimmed.length > APP_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `'name' must be ${APP_NAME_MIN_LENGTH}-${APP_NAME_MAX_LENGTH} characters after trimming`
    );
  }
  return trimmed;
}

function validateAppDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException("'description' must be a string or null");
  }
  const trimmed = value.trim();
  if (trimmed.length > APP_DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException(
      `'description' must be at most ${APP_DESCRIPTION_MAX_LENGTH} characters after trimming`
    );
  }
  return trimmed.length === 0 ? null : trimmed;
}
import { ProjectAuthService } from './project-auth.service';
import { ProjectEventsService } from './project-events.service';
import { AppService } from './app.service';
import { AppReadinessService } from './app-readiness.service';
import { AgentStatusService } from './agent-status.service';
import {
  ACTIVE_DUPLICATE_STATUSES,
  PROJECT_DUPLICATE_QUEUE,
  ProjectDuplicateStatus,
  type ProjectDuplicateJobData,
  type ProjectDuplicateJobResponse,
} from './project-duplicate.types';
import { ACTIVE_IMPORT_STATUSES, ProjectImportStatus } from './project-import.types';
import { ACTIVE_PUBLISH_STATUSES } from '../publish/publish.types';
import { DeliveryService } from '../delivery/delivery.service';

export type ProjectActivityKind = 'agent' | 'app';

export interface EnsureEnvironmentResult {
  state: 'ready' | 'starting' | 'disabled' | 'failed';
  env: ProjectEnvironmentContext;
}

const projectOrderBy = () =>
  [
    asc(sql`CASE WHEN ${projects.disabled} THEN 1 ELSE 0 END`),
    desc(sql`COALESCE(${projects.lastPromptAt}, ${projects.createdAt})`),
    desc(projects.createdAt),
  ] as const;

const effectiveStatus = sql<ProjectStatus>`CASE WHEN ${projects.disabled} THEN 'disabled' ELSE ${projectEnvironments.status} END`;

const projectEnvAll = alias(projectEnvironments, 'project_env_all');
const projectAppEnv = alias(projectApps, 'project_app_env');

const projectSelectFields = {
  id: projects.id,
  tenantId: projects.tenantId,
  workspaceId: projects.workspaceId,
  folderId: projects.folderId,
  agentId: projects.agentId,
  title: projects.title,
  description: projects.description,
  disabled: projects.disabled,
  bifrostProjectId: projects.bifrostProjectId,
  createdBy: projects.createdBy,
  createdByProjectId: projects.createdByProjectId,
  kind: projects.kind,
  importedAgent: projects.importedAgent,
  directory: projectEnvironments.directory,
  status: effectiveStatus.as('status'),
  podIp: projectEnvironments.podIp,
  authMode: projectEnvironments.authMode,
  timeoutIdle: projectSettings.timeoutIdle,
  appTimeoutIdle: projectSettings.appTimeoutIdle,
  timezone: projectSettings.timezone,
  requestLogMode: projectSettings.requestLogMode,
  requestLogBodyLimit: projectSettings.requestLogBodyLimit,
  podClass: projectPodSettings.podClass,
  cpuMillicores: projectPodSettings.cpuMillicores,
  memoryRequestMib: projectPodSettings.memoryRequestMib,
  memoryLimitMib: projectPodSettings.memoryLimitMib,
  hasApp: sql<boolean>`${projectApps.projectEnvironmentId} is not null`.as('has_app'),
  appName: projectApps.name,
  appDescription: projectApps.description,
  environmentIds: sql<string[]>`(
    SELECT COALESCE(array_agg(DISTINCT ${projectEnvAll.environmentId}), '{}')
    FROM ${projectEnvironments} AS ${projectEnvAll}
    INNER JOIN ${projectApps} AS ${projectAppEnv}
      ON ${projectAppEnv.projectEnvironmentId} = ${projectEnvAll.id}
    WHERE ${projectEnvAll.projectId} = ${projects.id}
      AND ${projectEnvAll.environmentId} IS NOT NULL
  )`.as('environment_ids'),
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

@Injectable()
export class ProjectService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProjectService.name);
  private readonly startupTasks = new Map<string, Promise<void>>();
  private readonly startupRetries = new Map<string, number>();
  private readonly recreateRequests = new Set<string>();
  private readonly recoveryStartups = new Set<string>();
  constructor(
    private readonly podService: PodService,
    private readonly podCache: PodCacheService,
    private readonly projectPoolService: ProjectPoolService,
    private readonly timeoutService: TimeoutService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => BifrostService))
    private readonly bifrostService: BifrostService,
    private readonly defaultsService: DefaultsService,
    private readonly gatewayKeyService: GatewayKeyService,
    @Inject(forwardRef(() => ScheduleService))
    private readonly scheduleService: ScheduleService,
    private readonly projectAuthService: ProjectAuthService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly appService: AppService,
    private readonly appReadiness: AppReadinessService,
    private readonly agentStatusService: AgentStatusService,
    private readonly agentService: AgentService,
    private readonly environmentService: EnvironmentService,
    private readonly gitService: GitService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly externalServiceProvisioning: ExternalServiceProvisioningService,
    private readonly proxyService: ProxyService,
    private readonly deliveryService: DeliveryService,
    @InjectQueue(PROJECT_DUPLICATE_QUEUE)
    private readonly duplicateQueue: Queue<ProjectDuplicateJobData>
  ) {}

  async onApplicationBootstrap() {
    this.podCache.onDelete((podName, pod) => this.handleAgentPodDeleteEvent(podName, pod));
    await this.cleanupOrphanedAssignedPods().catch((err) => {
      this.logger.warn(`Failed to clean up orphaned assigned pods: ${err.message}`);
    });
    await this.recoverDuplicateJobs().catch((err) => {
      this.logger.warn(`Failed to recover duplicate jobs on startup: ${err.message}`);
    });
    await this.recoverImportJobs().catch((err) => {
      this.logger.warn(`Failed to recover import jobs on startup: ${err.message}`);
    });
    await this.resumeStartingEnvironments().catch((err) => {
      this.logger.warn(`Failed to resume starting environments: ${err.message}`);
    });
    await this.recoverActiveEnvironmentsMissingPods().catch((err) => {
      this.logger.warn(`Failed to recover active environments with missing pods: ${err.message}`);
    });
  }

  private async resumeStartingEnvironments(): Promise<void> {
    const stranded = (await this.projectEnvironmentService.listByStatus(ProjectStatus.Publishing)).filter(
      (env) => !env.disabled
    );
    for (const env of stranded) {
      const recoveredStatus = await this.rollBackStrandedPublish(env);
      await this.projectEnvironmentService
        .patch(env.id, { status: recoveredStatus, podIp: null }, ProjectStatus.Publishing)
        .catch((err) => {
          this.logger.warn(`Failed to recover publishing environment ${env.id}: ${(err as Error).message}`);
        });
    }
    if (stranded.length > 0) {
      this.logger.warn(
        `Recovered ${stranded.length} environment(s) stranded mid-publish after restart; their publish jobs were marked failed, deployed environments were rolled back to their last deployed commit, never-deployed ones were marked failed`
      );
    }

    const rows = await this.projectEnvironmentService.listByStatus(ProjectStatus.Starting);
    const active = rows.filter((env) => !env.disabled);

    for (const env of active) {
      this.spawnStartupWorker(env.id);
    }

    if (active.length > 0) {
      this.logger.log(`Resumed startup workers for ${active.length} environment(s) in 'starting' state`);
    }
  }

  private async rollBackStrandedPublish(env: ProjectEnvironmentContext): Promise<ProjectStatus> {
    if (env.deployedCommitSha === null) return ProjectStatus.Failed;
    const storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    try {
      await this.gitService.resetHard(path.join(storageMountPath, env.directory), env.deployedCommitSha);
      await restoreEnvJsonBackup(storageMountPath, env.directory);
      return ProjectStatus.Starting;
    } catch (err) {
      this.logger.warn(
        `Failed to roll back stranded environment ${env.id} to deployed commit ${env.deployedCommitSha}: ${(err as Error).message}`
      );
      return ProjectStatus.Failed;
    }
  }

  private async cleanupOrphanedAssignedPods(): Promise<void> {
    const agentPods = await this.podService.listPods('app=opsiforce-agent');
    const podRefs = agentPods
      .map((pod) => ({
        name: pod.metadata?.name ?? null,
        envId: environmentIdFromPodLabels(pod),
      }))
      .filter((pod): pod is { name: string; envId: string } => !!pod.name && !!pod.envId);

    if (podRefs.length === 0) return;

    const envIds = Array.from(new Set(podRefs.map((pod) => pod.envId)));
    const existingRows = await db
      .select({ id: projectEnvironments.id, status: projectEnvironments.status, disabled: projects.disabled })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(inArray(projectEnvironments.id, envIds));
    const envsExpectingPod = new Set(
      existingRows
        .filter(
          (row) =>
            !row.disabled &&
            (row.status === ProjectStatus.Starting ||
              row.status === ProjectStatus.Active ||
              row.status === ProjectStatus.Pending ||
              row.status === ProjectStatus.Claiming)
        )
        .map((row) => row.id)
    );
    const orphanedPods = podRefs.filter((pod) => !envsExpectingPod.has(pod.envId));

    await Promise.allSettled(
      orphanedPods.map((pod) => {
        this.logger.warn(`Deleting orphaned assigned pod ${pod.name} for missing environment ${pod.envId}`);
        return this.safeDeletePod(pod.name, `orphaned environment ${pod.envId}`);
      })
    );
  }

  private async recoverActiveEnvironmentsMissingPods(): Promise<void> {
    const activeEnvs = await this.projectEnvironmentService.listByStatus(ProjectStatus.Active);
    const recovered: string[] = [];
    for (const env of activeEnvs) {
      try {
        if (await this.recoverEnvironmentIfPodMissing(env)) recovered.push(env.id);
      } catch (err) {
        this.logger.warn(`Skipping recovery for environment ${env.id}: ${(err as Error).message}`);
      }
    }
    if (recovered.length > 0) {
      this.logger.log(
        `Recovered ${recovered.length} active environment(s) whose pods were externally deleted: ${recovered.join(', ')}`
      );
    }
  }

  private handleAgentPodDeleteEvent(podName: string, pod: V1Pod): void {
    const envId = environmentIdFromPodLabels(pod);
    if (!envId) return;
    void (async () => {
      const env = await this.projectEnvironmentService.findByIdOrNull(envId);
      if (!env) return;
      if (await this.recoverEnvironmentIfPodMissing(env)) {
        this.logger.log(`Delete event for pod ${podName}: recovery started for environment ${env.id}`);
      }
    })().catch((err) => {
      this.logger.warn(`Failed to recover after delete event for pod ${podName}: ${(err as Error).message}`);
    });
  }

  private async recoverEnvironmentIfPodMissing(env: ProjectEnvironmentContext): Promise<boolean> {
    if (env.disabled || env.status !== ProjectStatus.Active) return false;
    if (await this.timeoutService.isFullyExpired(env.id)) return false;

    const podName = this.podService.assignedPodName(env.id);
    let pod: V1Pod | null;
    try {
      pod = await this.readPodOrNull(podName);
    } catch (err) {
      this.logger.warn(
        `Skipping recovery for environment ${env.id}: cannot confirm pod ${podName} is absent: ${(err as Error).message}`
      );
      return false;
    }
    if (pod && !pod.metadata?.deletionTimestamp) return false;

    const [updated] = await db
      .update(projectEnvironments)
      .set({ status: ProjectStatus.Starting, podIp: null, updatedAt: new Date() })
      .where(
        and(
          eq(projectEnvironments.id, env.id),
          eq(projectEnvironments.status, ProjectStatus.Active),
          sql`exists (select 1 from ${projects} where ${projects.id} = ${projectEnvironments.projectId} and ${projects.disabled} = false)`
        )
      )
      .returning({ id: projectEnvironments.id });
    if (!updated) return false;

    this.logger.log(`Recovering environment ${env.id}: pod ${podName} gone while status was 'active'`);
    this.appReadiness.markDown(env.id);
    this.recoveryStartups.add(env.id);
    this.spawnStartupWorker(env.id);
    await this.projectEventsService.publish(env.projectId).catch((err) => {
      this.logger.warn(`Failed to publish recovery event for environment ${env.id}: ${(err as Error).message}`);
    });
    return true;
  }

  async create(
    dto: CreateProjectDto | undefined,
    tenantId: string,
    context: ProjectCreationContext = {}
  ): Promise<ProjectResponse> {
    const { workspaceId = null, folderId = null, createdBy = null, createdByProjectId = null, kind = null } = context;
    const agentId = dto?.agentId ?? (await this.agentService.getDefaultAgentId(tenantId));
    if (dto?.agentId) await this.agentService.assertLiveForProjectCreate(agentId, tenantId, createdBy, kind);
    const timeouts = await this.defaultsService.getTenantTimeouts(tenantId);

    const claimedId = await this.projectPoolService
      .claimPending(agentId, {
        tenantId,
        workspaceId,
        folderId,
        title: dto?.title ?? null,
        description: dto?.description ?? null,
        createdBy,
        createdByProjectId,
        kind,
        timeoutIdle: timeouts.defaultTimeoutIdle,
        appTimeoutIdle: timeouts.defaultAppTimeoutIdle,
        timezone: dto?.timezone || 'UTC',
      })
      .catch((err) => {
        this.logger.warn(`Pool claim failed; falling back to slow path: ${(err as Error).message}`);
        return null;
      });

    if (claimedId) {
      const project = await this.findOne(claimedId, tenantId);
      await Promise.allSettled([this.timeoutService.touch(project.id), this.projectEventsService.publish(project.id)]);
      return project;
    }

    return this.createDirect(dto, tenantId, agentId, timeouts, {
      workspaceId,
      folderId,
      createdBy,
      createdByProjectId,
      kind,
    });
  }

  private async createDirect(
    dto: CreateProjectDto | undefined,
    tenantId: string,
    agentId: string,
    timeouts: { defaultTimeoutIdle: number; defaultAppTimeoutIdle: number },
    context: Required<ProjectCreationContext>
  ): Promise<ProjectResponse> {
    const { workspaceId, folderId, createdBy, createdByProjectId, kind } = context;
    const id = crypto.randomUUID();
    const directory = `projects/${id}`;
    const platformVersion = this.configService.get<string>('platformVersion', '0.1.0');
    const defaultEnvironment = await this.environmentService.ensureDefaultForTenant(tenantId);

    await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        tenantId,
        workspaceId,
        folderId,
        agentId,
        title: dto?.title ?? null,
        description: dto?.description ?? null,
        createdBy,
        createdByProjectId,
        kind,
      });

      await tx.insert(projectSettings).values({
        projectId: id,
        timeoutIdle: timeouts.defaultTimeoutIdle,
        appTimeoutIdle: timeouts.defaultAppTimeoutIdle,
        timezone: dto?.timezone || 'UTC',
      });

      await tx.insert(projectPodSettings).values({
        projectId: id,
        podClass: 'small',
        ...resolvePreset('small'),
      });

      await tx.insert(projectEnvironments).values({
        id,
        projectId: id,
        environmentId: defaultEnvironment.id,
        isDefault: true,
        directory,
        platformVersion,
        status: ProjectStatus.Starting,
      });
    });

    await this.externalServiceProvisioning.provisionEnvironment(id);
    await this.createBifrostResources(id, tenantId);
    await this.createGatewayKeys(id, id, tenantId, agentId, createdByProjectId);
    try {
      await this.deliveryService.deliverAtCreate(id);
    } catch (err) {
      await this.discardHalfCreatedProject(id);
      throw new InternalServerErrorException(`Could not deliver the agent's files: ${(err as Error).message}`);
    }
    this.spawnStartupWorker(id);

    return this.findOne(id, tenantId);
  }

  async duplicate(
    sourceId: string,
    tenantId: string,
    dto: DuplicateProjectDto | undefined,
    createdBy: string | null
  ): Promise<ProjectResponse> {
    const [source] = await db
      .select({ kind: projects.kind })
      .from(projects)
      .where(and(eq(projects.id, sourceId), eq(projects.tenantId, tenantId)));
    if (isChatKind(source?.kind)) {
      throw new BadRequestException({
        code: 'not_duplicable',
        message: 'A Builder chat belongs to its skill or agent and cannot be duplicated',
      });
    }
    return this.duplicateOne(sourceId, tenantId, dto, createdBy);
  }

  private async duplicateOne(
    sourceId: string,
    tenantId: string,
    dto: DuplicateProjectDto | undefined,
    createdBy: string | null
  ): Promise<ProjectResponse> {
    const source = await this.findOne(sourceId, tenantId);
    const parentProjectId = source.createdByProjectId;
    await this.assertNoActiveGitOperation(source.id);

    const id = crypto.randomUUID();
    const duplicateJobId = crypto.randomUUID();
    const directory = `projects/${id}`;
    const platformVersion = this.configService.get<string>('platformVersion', '0.1.0');
    const title = dto?.title ?? (source.title ? `${source.title} (copy)` : null);
    const defaultEnvironment = await this.environmentService.ensureDefaultForTenant(tenantId);
    const [sourceApp] = await db.select().from(projectApps).where(eq(projectApps.projectEnvironmentId, source.id));
    const sourceSchedules = await db
      .select()
      .from(projectSchedules)
      .where(eq(projectSchedules.projectEnvironmentId, source.id));

    await db.transaction(async (tx) => {
      await lockProjectGit(tx, source.id);
      await this.assertNoActiveGitOperation(source.id, tx);

      await tx.insert(projects).values({
        id,
        tenantId,
        workspaceId: source.workspaceId,
        agentId: source.agentId,
        kind: source.kind,
        title,
        description: source.description,
        createdBy,
        createdByProjectId: parentProjectId,
      });

      await tx.insert(projectSettings).values({
        projectId: id,
        timeoutIdle: source.timeoutIdle,
        appTimeoutIdle: source.appTimeoutIdle,
        timezone: source.timezone,
        requestLogMode: source.requestLogMode,
        requestLogBodyLimit: source.requestLogBodyLimit,
      });

      await tx.insert(projectPodSettings).values({
        projectId: id,
        podClass: source.podClass,
        cpuMillicores: source.cpuMillicores,
        memoryRequestMib: source.memoryRequestMib,
        memoryLimitMib: source.memoryLimitMib,
      });

      await tx.insert(projectEnvironments).values({
        id,
        projectId: id,
        environmentId: defaultEnvironment.id,
        isDefault: true,
        directory,
        platformVersion,
        status: ProjectStatus.Starting,
        authMode: source.authMode,
      });

      if (sourceApp) {
        await tx.insert(projectApps).values({
          projectEnvironmentId: id,
          projectId: id,
          name: sourceApp.name,
          description: sourceApp.description,
        });
      }

      if (sourceSchedules.length > 0) {
        await tx.insert(projectSchedules).values(
          sourceSchedules.map((schedule) => ({
            id: crypto.randomUUID(),
            projectId: id,
            projectEnvironmentId: id,
            tenantId,
            name: schedule.name,
            cronPattern: schedule.cronPattern,
            timeZone: schedule.timeZone,
            targetPath: schedule.targetPath,
            method: schedule.method,
            body: schedule.body,
            headers: schedule.headers,
            isActive: false,
          }))
        );
      }

      await tx.insert(projectDuplicateJobs).values({
        id: duplicateJobId,
        sourceProjectId: source.id,
        targetProjectId: id,
        tenantId,
        status: ProjectDuplicateStatus.Queued,
      });
    });

    await this.externalServiceProvisioning.provisionEnvironment(id);
    await this.createBifrostResources(id, tenantId);
    await this.createGatewayKeys(id, id, tenantId, source.agentId, parentProjectId);
    await this.enqueueDuplicateJob({
      duplicateJobId,
      sourceProjectId: source.id,
      targetProjectId: id,
    });
    await this.projectEventsService.publish(id);

    return this.findOne(id, tenantId);
  }

  async createImportedProject(params: {
    tenantId: string;
    workspaceId: string | null;
    folderId: string | null;
    title: string | null;
    timezone: string;
    agentId: string;
    importedAgent: string | null;
    description: string | null;
    settings: ExportManifestSettings | null;
    resources: ExportManifestResources | null;
    appDetails: ExportManifestAppDetails | null;
    schedules: ExportManifestSchedule[];
    createdBy: string | null;
  }): Promise<ProjectResponse> {
    const {
      tenantId,
      workspaceId,
      folderId,
      title,
      timezone,
      agentId,
      importedAgent,
      description,
      settings,
      resources,
      appDetails,
      schedules,
      createdBy,
    } = params;
    const id = crypto.randomUUID();
    const directory = `projects/${id}`;
    const platformVersion = this.configService.get<string>('platformVersion', '0.1.0');
    const timeouts = await this.defaultsService.getTenantTimeouts(tenantId);
    const defaultEnvironment = await this.environmentService.ensureDefaultForTenant(tenantId);
    const tz = timezone || 'UTC';
    const podResources = this.resolveImportedResources(resources);

    await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        tenantId,
        workspaceId,
        folderId,
        agentId,
        importedAgent,
        title,
        description,
        createdBy,
      });

      await tx.insert(projectSettings).values({
        projectId: id,
        timeoutIdle: settings?.timeoutIdle ?? timeouts.defaultTimeoutIdle,
        appTimeoutIdle: settings?.appTimeoutIdle ?? timeouts.defaultAppTimeoutIdle,
        timezone: tz,
        ...(settings
          ? { requestLogMode: settings.requestLogMode, requestLogBodyLimit: settings.requestLogBodyLimit }
          : {}),
      });

      await tx.insert(projectPodSettings).values({
        projectId: id,
        podClass: podResources.podClass,
        ...podResources.resources,
      });

      await tx.insert(projectEnvironments).values({
        id,
        projectId: id,
        environmentId: defaultEnvironment.id,
        isDefault: true,
        directory,
        platformVersion,
        status: ProjectStatus.Starting,
        authMode: 'public',
      });

      if (appDetails) {
        await tx.insert(projectApps).values({
          projectEnvironmentId: id,
          projectId: id,
          name: appDetails.name,
          description: appDetails.description,
        });
      }

      if (schedules.length > 0) {
        await tx.insert(projectSchedules).values(
          schedules.map((schedule) => ({
            id: crypto.randomUUID(),
            projectId: id,
            projectEnvironmentId: id,
            tenantId,
            name: schedule.name,
            cronPattern: schedule.cronPattern,
            timeZone: tz,
            targetPath: schedule.targetPath,
            method: schedule.method,
            body: schedule.body,
            headers: schedule.headers,
            isActive: false,
          }))
        );
      }
    });

    await this.externalServiceProvisioning.provisionEnvironment(id);
    await this.createBifrostResources(id, tenantId);
    await this.createGatewayKeys(id, id, tenantId, agentId, null);

    return this.findOne(id, tenantId);
  }

  private resolveImportedResources(resources: ExportManifestResources | null): {
    podClass: PodClass;
    resources: PodResources;
  } {
    if (resources?.podClass === 'custom') {
      return {
        podClass: 'custom',
        resources: clampCustom({
          cpuMillicores: resources.cpuMillicores,
          memoryRequestMib: resources.memoryRequestMib,
          memoryLimitMib: resources.memoryLimitMib,
        }),
      };
    }
    if (resources && isPreset(resources.podClass)) {
      return { podClass: resources.podClass, resources: resolvePreset(resources.podClass) };
    }
    return { podClass: 'small', resources: resolvePreset('small') };
  }

  async getSchedulesForExport(projectEnvironmentId: string): Promise<ExportManifestSchedule[]> {
    const rows = await db
      .select({
        name: projectSchedules.name,
        cronPattern: projectSchedules.cronPattern,
        timeZone: projectSchedules.timeZone,
        targetPath: projectSchedules.targetPath,
        method: projectSchedules.method,
        body: projectSchedules.body,
        headers: projectSchedules.headers,
      })
      .from(projectSchedules)
      .where(eq(projectSchedules.projectEnvironmentId, projectEnvironmentId));

    return rows.map((row) => ({
      name: row.name,
      cronPattern: row.cronPattern,
      timeZone: row.timeZone,
      targetPath: row.targetPath,
      method: row.method,
      body: (row.body ?? null) as JsonValue,
      headers: (row.headers ?? null) as Record<string, string> | null,
    }));
  }

  async ensureEnvironmentById(envId: string, activity: ProjectActivityKind): Promise<EnsureEnvironmentResult> {
    const env = await this.projectEnvironmentService.findByIdOrNull(envId);
    if (!env) throw new NotFoundException(`Project environment ${envId} not found`);
    return this.ensureEnvironment(env, activity);
  }

  async findAll(tenantId: string): Promise<ProjectResponse[]> {
    return this.selectProjects(tenantId);
  }

  async findAllForUser(params: { tenantId: string; userId: string }): Promise<ProjectResponse[]> {
    const { tenantId, userId } = params;
    const visible = visibleProjectsFilter(tenantId, userId);

    const rows = (await db
      .select(projectSelectFields)
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
      .innerJoin(projectPodSettings, eq(projectPodSettings.projectId, projects.id))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, projects.id))
      .leftJoin(workspaceMembers, visible.workspaceMemberJoin)
      .where(visible.where)
      .orderBy(...projectOrderBy())) as ProjectResponse[];

    for (const row of rows) {
      row.agentStatus = this.agentStatusService.statusOf(row.id);
    }
    return rows;
  }

  /** Every Project this user may watch: the ordinary visible set plus the hidden ones they created. */
  async findVisibleProjectIds(params: { tenantId: string; userId: string }): Promise<string[]> {
    const { tenantId, userId } = params;
    const accessible = accessibleProjectsFilter(tenantId, userId);

    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .leftJoin(workspaceMembers, accessible.workspaceMemberJoin)
      .where(accessible.where);
    return rows.map((row) => row.id);
  }

  async findAllInWorkspace(tenantId: string, workspaceId: string): Promise<ProjectResponse[]> {
    return this.selectProjects(tenantId, eq(projects.workspaceId, workspaceId));
  }

  private selectProjects(tenantId: string, scope?: SQL): Promise<ProjectResponse[]> {
    return db
      .select(projectSelectFields)
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
      .innerJoin(projectPodSettings, eq(projectPodSettings.projectId, projects.id))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, projects.id))
      .where(and(eq(projects.tenantId, tenantId), isNull(projects.kind), scope))
      .orderBy(...projectOrderBy()) as Promise<ProjectResponse[]>;
  }

  async findOne(id: string, tenantId: string): Promise<ProjectResponse> {
    const [project] = (await db
      .select(projectSelectFields)
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
      .innerJoin(projectPodSettings, eq(projectPodSettings.projectId, projects.id))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, projects.id))
      .where(and(eq(projects.id, id), eq(projects.tenantId, tenantId)))) as ProjectResponse[];
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async findOneUnlessHidden(id: string, tenantId: string, userId: string): Promise<ProjectResponse> {
    const project = await this.findOne(id, tenantId);
    if (project.kind !== null && !(await isHiddenProjectReachable(tenantId, userId, id))) {
      throw new NotFoundException(`Project ${id} not found`);
    }
    return project;
  }

  async findOneForUser(params: { projectId: string; tenantId: string; userId: string }): Promise<ProjectResponse> {
    const { projectId, tenantId, userId } = params;
    const project = await this.findOneUnlessHidden(projectId, tenantId, userId);
    await this.assertProjectVisibleToUser(project.id, project.workspaceId, userId);
    return project;
  }

  private async assertProjectVisibleToUser(
    projectId: string,
    workspaceId: string | null,
    userId: string
  ): Promise<void> {
    if (!workspaceId) return;

    const [ws] = await db
      .select({
        type: workspaces.type,
        ownerId: workspaces.ownerId,
        privateWorkspaceEnabled: tenantSettings.privateWorkspaceEnabled,
      })
      .from(workspaces)
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, workspaces.tenantId))
      .where(eq(workspaces.id, workspaceId));

    if (!ws) return;

    if (ws.type === 'private') {
      const privateWorkspacesEnabled = ws.privateWorkspaceEnabled ?? true;
      if (ws.ownerId !== userId || !privateWorkspacesEnabled) {
        throw new NotFoundException(`Project ${projectId} not found`);
      }
      return;
    }

    const [member] = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (!member) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  async getState(params: { projectId: string; tenantId: string; userId: string }): Promise<ProjectState> {
    const { projectId, tenantId, userId } = params;

    const [row] = await db
      .select({
        id: projects.id,
        status: projectEnvironments.status,
        disabled: projects.disabled,
        workspaceId: projects.workspaceId,
        title: projects.title,
        kind: projects.kind,
        createdBy: projects.createdBy,
      })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)));

    if (!row) throw new NotFoundException(`Project ${projectId} not found`);
    if (row.kind !== null && !(await isHiddenProjectReachable(tenantId, userId, projectId))) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.assertProjectVisibleToUser(row.id, row.workspaceId, userId);

    const status = row.disabled ? ProjectStatus.Disabled : (row.status as ProjectStatus);
    const app = status === ProjectStatus.Active ? await this.appService.get(row.id) : null;
    return {
      id: row.id,
      status,
      workspaceId: row.workspaceId,
      title: row.title,
      app,
    };
  }

  async findOneById(id: string): Promise<ProjectResponse> {
    const [project] = (await db
      .select(projectSelectFields)
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
      .innerJoin(projectPodSettings, eq(projectPodSettings.projectId, projects.id))
      .leftJoin(projectApps, eq(projectApps.projectEnvironmentId, projects.id))
      .where(eq(projects.id, id))) as ProjectResponse[];

    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async listEnvironments(projectId: string, tenantId: string): Promise<ProjectEnvironmentSummary[]> {
    await this.findOne(projectId, tenantId);
    const envs = await this.projectEnvironmentService.listByProjectId(projectId);
    const appRows = await db
      .select({
        projectEnvironmentId: projectApps.projectEnvironmentId,
        name: projectApps.name,
        description: projectApps.description,
      })
      .from(projectApps)
      .where(eq(projectApps.projectId, projectId));
    const appByEnv = new Map(appRows.map((row) => [row.projectEnvironmentId, row]));

    return envs
      .toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime())
      .map((env) => {
        const app = appByEnv.get(env.id);
        return {
          id: env.id,
          projectId: env.projectId,
          environmentId: env.environmentId,
          name: env.isDefault ? 'Development' : (env.environmentName ?? 'Environment'),
          slug: env.environmentSlug,
          isDefault: env.isDefault,
          status: env.disabled ? ProjectStatus.Disabled : env.status,
          authMode: env.authMode,
          deployedCommitSha: env.deployedCommitSha,
          lastActiveAt: env.lastActiveAt,
          hasApp: !!app,
          appName: app?.name ?? null,
          appDescription: app?.description ?? null,
          sessionId: env.sessionId,
        };
      });
  }

  async update(id: string, dto: UpdateProjectDto, tenantId: string): Promise<ProjectResponse> {
    const project = await this.findOne(id, tenantId);
    const now = new Date();
    const projectUpdates: Partial<typeof projects.$inferInsert> = {};
    const settingsUpdates: Partial<typeof projectSettings.$inferInsert> = {};

    if (dto.title !== undefined) projectUpdates.title = dto.title;
    if (dto.description !== undefined) projectUpdates.description = dto.description;
    if (dto.timeoutIdle !== undefined)
      settingsUpdates.timeoutIdle = assertIdleTimeoutMs(dto.timeoutIdle, 'timeoutIdle');
    if (dto.appTimeoutIdle !== undefined)
      settingsUpdates.appTimeoutIdle = assertIdleTimeoutMs(dto.appTimeoutIdle, 'appTimeoutIdle');
    if (dto.timezone !== undefined) settingsUpdates.timezone = dto.timezone;

    await db.transaction(async (tx) => {
      if (Object.keys(projectUpdates).length > 0) {
        await tx
          .update(projects)
          .set({ ...projectUpdates, updatedAt: now })
          .where(eq(projects.id, project.id));
      }

      if (Object.keys(settingsUpdates).length > 0) {
        await tx.update(projectSettings).set(settingsUpdates).where(eq(projectSettings.projectId, project.id));
      }
    });

    if (dto.timeoutIdle !== undefined) {
      await this.timeoutService.touch(id).catch((err) => {
        this.logger.warn(`Failed to refresh agent timeout for project ${id}: ${(err as Error).message}`);
      });
    }
    if (dto.appTimeoutIdle !== undefined) {
      await this.timeoutService.touchApp(id).catch((err) => {
        this.logger.warn(`Failed to refresh app timeout for project ${id}: ${(err as Error).message}`);
      });
    }

    return this.findOne(id, tenantId);
  }

  getPodClassCatalog(): PodClassCatalog {
    return buildPodClassCatalog();
  }

  async updatePodClass(id: string, dto: UpdateProjectPodClassDto, tenantId: string): Promise<ProjectResponse> {
    const project = await this.findOne(id, tenantId);
    const resources = this.resolvePodClassResources(dto);

    await db
      .update(projectPodSettings)
      .set({ podClass: dto.podClass, ...resources })
      .where(eq(projectPodSettings.projectId, project.id));

    return this.findOne(id, tenantId);
  }

  private resolvePodClassResources(dto: UpdateProjectPodClassDto): PodResources {
    if (dto.podClass === 'custom') {
      if (
        typeof dto.cpuMillicores !== 'number' ||
        typeof dto.memoryRequestMib !== 'number' ||
        typeof dto.memoryLimitMib !== 'number'
      ) {
        throw new BadRequestException(
          'Custom pod class requires numeric cpuMillicores, memoryRequestMib, and memoryLimitMib'
        );
      }
      return clampCustom({
        cpuMillicores: dto.cpuMillicores,
        memoryRequestMib: dto.memoryRequestMib,
        memoryLimitMib: dto.memoryLimitMib,
      });
    }
    if (!isPreset(dto.podClass)) {
      throw new BadRequestException(`Unknown pod class: ${String(dto.podClass)}`);
    }
    return resolvePreset(dto.podClass);
  }

  private async podResourcesForProject(projectId: string): Promise<K8sResourceRequirements> {
    const [row] = await db
      .select({
        cpuMillicores: projectPodSettings.cpuMillicores,
        memoryRequestMib: projectPodSettings.memoryRequestMib,
        memoryLimitMib: projectPodSettings.memoryLimitMib,
      })
      .from(projectPodSettings)
      .where(eq(projectPodSettings.projectId, projectId));
    return toK8sResources(row ?? resolvePreset('small'));
  }

  async getLogging(id: string, tenantId: string): Promise<ProjectLoggingResponse> {
    const project = await this.findOne(id, tenantId);
    return { mode: project.requestLogMode, bodyLimit: project.requestLogBodyLimit };
  }

  async updateLogging(id: string, dto: UpdateProjectLoggingDto, tenantId: string): Promise<ProjectLoggingResponse> {
    const project = await this.findOne(id, tenantId);

    if (!Object.values(RequestLogMode).includes(dto.mode)) {
      throw new BadRequestException(`Unknown request log mode: ${dto.mode}`);
    }

    const settingsUpdates: Partial<typeof projectSettings.$inferInsert> = {
      requestLogMode: dto.mode,
    };

    if (dto.bodyLimit !== undefined) {
      if (!Number.isFinite(dto.bodyLimit) || dto.bodyLimit < 0) {
        throw new BadRequestException('bodyLimit must be a non-negative byte value');
      }
      settingsUpdates.requestLogBodyLimit = Math.min(Math.round(dto.bodyLimit), REQUEST_LOG_BODY_LIMIT_MAX);
    }

    await db.update(projectSettings).set(settingsUpdates).where(eq(projectSettings.projectId, project.id));

    return this.getLogging(id, tenantId);
  }

  private async resolveProjectEnvironment(
    projectId: string,
    environmentId: string,
    tenantId: string
  ): Promise<ProjectEnvironmentContext> {
    await this.findOne(projectId, tenantId);
    const env = await this.projectEnvironmentService.findById(environmentId);
    if (env.projectId !== projectId) {
      throw new NotFoundException(`Environment ${environmentId} not found`);
    }
    return env;
  }

  async getAuth(projectId: string, environmentId: string, tenantId: string): Promise<ProjectAuthResponse> {
    const env = await this.resolveProjectEnvironment(projectId, environmentId, tenantId);
    const callbackUrls = this.projectAuthService.callbackUrls(env.id, env.environmentSlug);
    if (env.authMode === 'public') return { mode: 'public', callbackUrls };
    const { config, bypassAuthPaths } = await this.projectAuthService.getConfig(env.id);
    if (env.authMode === 'managed') return { mode: 'managed', bypassAuthPaths, callbackUrls };
    return { mode: 'manual', config, bypassAuthPaths, callbackUrls };
  }

  async updateAuth(
    projectId: string,
    environmentId: string,
    dto: UpdateProjectAuthDto,
    tenantId: string
  ): Promise<ProjectAuthResponse> {
    const env = await this.resolveProjectEnvironment(projectId, environmentId, tenantId);
    const allowedModes = availableAuthModes({
      managedOidcClientSecret: this.configService.get<string>('managedOidcClientSecret'),
      managedOidcIssuerUrl: this.configService.get<string>('managedOidcIssuerUrl'),
    });
    if (!allowedModes.includes(dto.mode)) {
      throw new BadRequestException(`Unknown or unavailable auth mode: ${String(dto.mode)}`);
    }

    if (dto.mode === 'manual') {
      await this.projectAuthService.apply(env.id, env.environmentSlug, dto.config ?? {}, dto.bypassAuthPaths);
    } else if (dto.mode === 'managed') {
      const externalTenantName = await this.findExternalTenantName(tenantId);
      await this.projectAuthService.applyManaged(env.id, env.environmentSlug, externalTenantName, dto.bypassAuthPaths);
    } else {
      await this.projectAuthService.remove(env.id);
    }

    await db
      .update(projectEnvironments)
      .set({ authMode: dto.mode, updatedAt: new Date() })
      .where(eq(projectEnvironments.id, env.id));

    return this.getAuth(projectId, env.id, tenantId);
  }

  /** A Builder chat's test Projects go with it (ADR-0063); a pod's ordinary Projects outlive their creator (ADR-0062). */
  async remove(id: string, tenantId: string): Promise<void> {
    await this.findOne(id, tenantId);
    for (const child of await this.testProjectsCreatedBy(id, tenantId)) {
      await this.remove(child.id, tenantId);
    }
    const envs = await this.projectEnvironmentService.listByProjectId(id);

    await db
      .update(projectEnvironments)
      .set({ status: ProjectStatus.Suspended, podIp: null, updatedAt: new Date() })
      .where(eq(projectEnvironments.projectId, id));

    await Promise.allSettled([
      ...envs.map((env) => this.safeDeletePod(this.podService.assignedPodName(env.id), `removing project ${id}`)),
      this.bifrostService.isEnabled()
        ? this.bifrostService.revokeProjectKeys(id).catch((err) => {
            this.logger.warn(`Failed to revoke Bifrost keys for project ${id}: ${(err as Error).message}`);
          })
        : Promise.resolve(),
      this.gatewayKeyService.revokeKeys(id).catch((err) => {
        this.logger.warn(`Failed to revoke gateway keys for project ${id}: ${(err as Error).message}`);
      }),
      this.scheduleService.removeAllForProject(id).catch((err) => {
        this.logger.warn(`Failed to remove schedules for project ${id}: ${(err as Error).message}`);
      }),
      ...envs.map((env) => this.timeoutService.clear(env.id)),
    ]);

    envs.forEach((env) => {
      this.appReadiness.clear(env.id);
      this.agentStatusService.clear(id, env.id);
    });

    for (const env of envs) {
      await this.projectEnvironmentService.delete(env);
    }

    await db.delete(projects).where(eq(projects.id, id));
  }

  private testProjectsCreatedBy(projectId: string, tenantId: string): Promise<{ id: string; title: string | null }[]> {
    return db
      .select({ id: projects.id, title: projects.title })
      .from(projects)
      .where(
        and(
          eq(projects.tenantId, tenantId),
          eq(projects.createdByProjectId, projectId),
          eq(projects.kind, TEST_PROJECT_KIND)
        )
      )
      .orderBy(desc(projects.createdAt));
  }

  async disable(id: string, tenantId: string): Promise<ProjectResponse> {
    const project = await this.findOne(id, tenantId);
    if (project.disabled) {
      throw new BadRequestException('Project is already disabled');
    }

    const envs = await this.projectEnvironmentService.listByProjectId(id);

    await db.transaction(async (tx) => {
      await tx.update(projects).set({ disabled: true, updatedAt: new Date() }).where(eq(projects.id, id));
      await tx
        .update(projectEnvironments)
        .set({ podIp: null, updatedAt: new Date() })
        .where(eq(projectEnvironments.projectId, id));
    });

    await Promise.allSettled([
      ...envs.map((env) => this.safeDeletePod(this.podService.assignedPodName(env.id), `disabling project ${id}`)),
      ...envs.map((env) => this.timeoutService.clear(env.id)),
    ]);

    envs.forEach((env) => {
      this.appReadiness.markDown(env.id);
      this.agentStatusService.clear(id, env.id);
    });

    await this.projectEventsService.publish(id);

    return this.findOne(id, tenantId);
  }

  async enable(id: string, tenantId: string): Promise<ProjectResponse> {
    const project = await this.findOne(id, tenantId);
    if (!project.disabled) {
      throw new BadRequestException('Project is not disabled');
    }

    const envs = await this.projectEnvironmentService.listByProjectId(id);

    await db.update(projects).set({ disabled: false, updatedAt: new Date() }).where(eq(projects.id, id));
    await Promise.all(
      envs.map((env) => this.projectEnvironmentService.patch(env.id, { status: ProjectStatus.Starting, podIp: null }))
    );

    envs.forEach((env) => this.spawnStartupWorker(env.id));
    await this.projectEventsService.publish(id);
    return this.findOne(id, tenantId);
  }

  async restart(id: string, tenantId: string, environmentId?: string): Promise<ProjectResponse> {
    const project = await this.findOne(id, tenantId);
    if (project.disabled) {
      throw new BadRequestException('Disabled project cannot be restarted');
    }

    const env = await this.projectEnvironmentService.findById(environmentId ?? id);
    if (env.projectId !== id) {
      throw new NotFoundException(`Environment ${environmentId ?? id} not found`);
    }

    await this.requestEnvironmentStartup(env, { deleteExistingPod: true });
    return this.findOne(id, tenantId);
  }

  async removeEnvironment(projectId: string, environmentId: string, tenantId: string): Promise<void> {
    await this.findOne(projectId, tenantId);
    const env = await this.projectEnvironmentService.findById(environmentId);
    if (env.projectId !== projectId) {
      throw new NotFoundException(`Environment ${environmentId} not found`);
    }
    if (env.isDefault) {
      throw new BadRequestException('The Development environment cannot be deleted');
    }

    await this.projectEnvironmentService.patch(env.id, { status: ProjectStatus.Suspended, podIp: null });

    await Promise.allSettled([
      this.safeDeletePod(this.podService.assignedPodName(env.id), `deleting environment ${env.id}`),
      this.projectAuthService.remove(env.id).catch((err) => {
        this.logger.warn(`Failed to remove auth middleware for environment ${env.id}: ${(err as Error).message}`);
      }),
      this.bifrostService.isEnabled()
        ? this.bifrostService.revokeEnvironmentKeys(env.id).catch((err) => {
            this.logger.warn(`Failed to revoke Bifrost keys for environment ${env.id}: ${(err as Error).message}`);
          })
        : Promise.resolve(),
      this.gatewayKeyService.revokeEnvironmentKeys(env.id).catch((err) => {
        this.logger.warn(`Failed to revoke gateway keys for environment ${env.id}: ${(err as Error).message}`);
      }),
      this.scheduleService.removeAllForEnvironment(env.id).catch((err) => {
        this.logger.warn(`Failed to remove schedules for environment ${env.id}: ${(err as Error).message}`);
      }),
      this.timeoutService.clear(env.id),
    ]);

    this.appReadiness.clear(env.id);
    this.agentStatusService.clear(projectId, env.id);

    await this.projectEnvironmentService.delete(env);

    await this.projectEventsService.publish(projectId);
  }

  async updateApp(
    id: string,
    tenantId: string,
    environmentId: string | undefined,
    body: UpdateAppDto
  ): Promise<ProjectResponse> {
    await this.findOne(id, tenantId);
    const targetEnv = await this.projectEnvironmentService.findById(environmentId ?? id);
    if (targetEnv.projectId !== id) {
      throw new NotFoundException(`Environment ${environmentId ?? id} not found`);
    }

    const [appRow] = await db
      .select({ name: projectApps.name, description: projectApps.description })
      .from(projectApps)
      .where(eq(projectApps.projectEnvironmentId, targetEnv.id));
    if (!appRow) {
      throw new BadRequestException(
        'APP_NOT_DETECTED: this environment has no detectable app yet. Make sure app/startup.sh serves on $APP_PORT and app/app.meta.json exists before editing app details.'
      );
    }

    const patch = validateUpdateAppDto(body);
    const name = patch.name ?? appRow.name;
    const description = 'description' in patch ? (patch.description ?? null) : appRow.description;

    if (!name) {
      throw new BadRequestException("'name' is required and cannot be empty");
    }

    await this.writeAppMetaFile(targetEnv.directory, { name, description });
    await db
      .update(projectApps)
      .set({ name, description, updatedAt: new Date() })
      .where(eq(projectApps.projectEnvironmentId, targetEnv.id));

    await this.projectEventsService.publish(id);

    return this.findOne(id, tenantId);
  }

  private async writeAppMetaFile(
    projectDirectory: string,
    meta: { name: string; description: string | null }
  ): Promise<void> {
    const storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    const target = path.join(storageMountPath, projectDirectory, 'app', 'app.meta.json');
    const content: Record<string, JsonValue> = { name: meta.name };
    if (meta.description !== null) content.description = meta.description;
    await writeJsonAtomic(target, content);
  }

  async findExternalTenantName(tenantId: string): Promise<string> {
    const [row] = await db
      .select({
        externalTenantName: tenantSettings.externalTenantName,
        tenantName: tenants.name,
      })
      .from(tenants)
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, tenants.id))
      .where(eq(tenants.id, tenantId));
    if (!row) throw new BadRequestException(`Tenant ${tenantId} not found`);
    return row.externalTenantName ?? row.tenantName;
  }

  async reassignPodById(id: string): Promise<void> {
    const env = await this.projectEnvironmentService.findById(id);
    await this.requestEnvironmentStartup(env, { deleteExistingPod: true });
  }

  async requestStartupForId(id: string): Promise<void> {
    const env = await this.projectEnvironmentService.findById(id);
    await this.requestEnvironmentStartup(env, { deleteExistingPod: false });
  }

  async beginPublishDeploy(envId: string): Promise<void> {
    const updated = await this.projectEnvironmentService.patch(
      envId,
      { status: ProjectStatus.Publishing, podIp: null },
      [
        ProjectStatus.Active,
        ProjectStatus.Starting,
        ProjectStatus.Failed,
        ProjectStatus.Suspended,
        ProjectStatus.Publishing,
      ]
    );
    if (updated) {
      this.agentStatusService.clear(updated.projectId, envId);
      await this.projectEventsService.publish(updated.projectId).catch(() => undefined);
    }
  }

  async recreatePodForDeploy(envId: string, timeoutMs: number): Promise<string> {
    const env = await this.projectEnvironmentService.findById(envId);
    const podName = this.podService.assignedPodName(envId);
    await this.safeDeletePod(podName, `publish deploy for environment ${envId}`);
    await this.spawnPodForEnvironment(env);
    return this.podService.waitForReady(podName, timeoutMs);
  }

  async finishPublishDeploy(envId: string, podIp: string, deployedCommitSha: string): Promise<void> {
    const updated = await this.projectEnvironmentService.patch(
      envId,
      { status: ProjectStatus.Active, podIp, deployedCommitSha, lastActiveAt: new Date() },
      ProjectStatus.Publishing
    );
    if (!updated) {
      this.logger.warn(`finishPublishDeploy: environment ${envId} was not in 'publishing' state; leaving as-is`);
      return;
    }
    this.startupRetries.delete(envId);
    await Promise.allSettled([
      this.timeoutService.touch(envId).catch(() => undefined),
      this.projectEventsService.publish(updated.projectId).catch(() => undefined),
    ]);
  }

  async failPublishDeploy(envId: string): Promise<void> {
    const updated = await this.projectEnvironmentService.patch(
      envId,
      { status: ProjectStatus.Failed, podIp: null },
      ProjectStatus.Publishing
    );
    if (updated) {
      this.agentStatusService.clear(updated.projectId, envId);
      await this.projectEventsService.publish(updated.projectId).catch(() => undefined);
    }
  }

  async touchActivity(projectId: string): Promise<void> {
    await this.touchEnvironmentActivity(projectId, 'agent');
  }

  async touchEnvironmentActivity(envId: string, activity: ProjectActivityKind): Promise<void> {
    if (activity === 'agent') await this.timeoutService.touch(envId);
    else await this.timeoutService.touchApp(envId);
    await this.projectEnvironmentService.touchActivity(envId);
  }

  async ensureEnvironment(
    env: ProjectEnvironmentContext,
    activity: ProjectActivityKind
  ): Promise<EnsureEnvironmentResult> {
    if (env.status === ProjectStatus.Pending || env.status === ProjectStatus.Claiming) {
      throw new NotFoundException(`Project environment ${env.id} not found`);
    }

    if (env.disabled) {
      return { state: 'disabled', env };
    }

    if (env.status === ProjectStatus.Failed) {
      return { state: 'failed', env };
    }

    if (env.status === ProjectStatus.Publishing) {
      return { state: 'starting', env };
    }

    this.recordActivity(env.id, activity);

    if (env.status === ProjectStatus.Suspended) {
      return this.wakeSuspendedEnvironment(env);
    }

    if (env.status === ProjectStatus.Starting) {
      return this.handleStartingEnvironment(env);
    }

    if (env.podIp) {
      return this.verifyCachedActiveEnvironment(env);
    }

    return this.verifyActiveEnvironment(env);
  }

  async handleProxyFailureByEnvId(envId: string): Promise<boolean> {
    const env = await this.projectEnvironmentService.findByIdOrNull(envId);
    if (!env) return false;
    return this.handleProxyFailureForEnvironment(env);
  }

  async stampLastPromptByEnvId(envId: string): Promise<void> {
    const env = await this.projectEnvironmentService.findByIdOrNull(envId);
    if (!env) return;
    await db.update(projects).set({ lastPromptAt: new Date() }).where(eq(projects.id, env.projectId));
  }

  private async handleProxyFailureForEnvironment(env: ProjectEnvironmentContext): Promise<boolean> {
    if (env.disabled) return false;
    if (env.status === ProjectStatus.Failed) return false;
    if (env.status === ProjectStatus.Publishing) return false;

    if (env.status === ProjectStatus.Starting) {
      this.spawnStartupWorker(env.id);
      return true;
    }

    const podName = this.podService.assignedPodName(env.id);
    const pod = await this.readPodOrNull(podName);
    if (!pod || !this.podService.isPodReady(pod)) {
      await this.requestEnvironmentStartup(env, { deleteExistingPod: !!pod });
      return true;
    }

    const livePodIp = pod.status?.podIP ?? null;
    if (livePodIp && livePodIp !== env.podIp) {
      await this.projectEnvironmentService.patch(env.id, { podIp: livePodIp }, ProjectStatus.Active);
      this.logger.warn(`Repaired stale pod_ip for environment ${env.id}: ${env.podIp} -> ${livePodIp}`);
    }

    return false;
  }

  private async wakeSuspendedEnvironment(env: ProjectEnvironmentContext): Promise<EnsureEnvironmentResult> {
    const updated = await this.projectEnvironmentService.patch(
      env.id,
      { status: ProjectStatus.Starting, podIp: null },
      ProjectStatus.Suspended
    );

    if (updated) {
      await this.projectEventsService.publish(env.projectId);
    }

    this.spawnStartupWorker(env.id);
    return {
      state: 'starting',
      env: { ...env, status: ProjectStatus.Starting, podIp: null },
    };
  }

  private async handleStartingEnvironment(env: ProjectEnvironmentContext): Promise<EnsureEnvironmentResult> {
    const podName = this.podService.assignedPodName(env.id);
    const pod = await this.readPodOrNull(podName);

    if (!pod) {
      this.spawnStartupWorker(env.id);
      return { state: 'starting', env };
    }

    const podIp = pod.status?.podIP ?? null;
    if (this.podService.isPodReady(pod) && podIp) {
      await this.markEnvironmentActive(env.id, podIp, podName);
      return {
        state: 'ready',
        env: { ...env, status: ProjectStatus.Active, podIp },
      };
    }

    const failure = this.podService.inspectFailureReason(pod);
    if (failure === 'ImagePullBackOff') {
      await this.handleStartupFailure(
        env.id,
        podName,
        new PodStartupFailedError(podName, failure, this.podService.inspectFailureMessage(pod))
      );
      return {
        state: 'failed',
        env: { ...env, status: ProjectStatus.Failed, podIp: null },
      };
    }

    if (failure === 'Unschedulable' && this.podService.podAgeMs(pod) > UNSCHEDULABLE_STARTUP_GRACE_MS) {
      await this.handleStartupFailure(
        env.id,
        podName,
        new PodStartupFailedError(podName, failure, this.podService.inspectFailureMessage(pod))
      );
      return {
        state: 'failed',
        env: { ...env, status: ProjectStatus.Failed, podIp: null },
      };
    }

    if (failure === 'CrashLoopBackOff') {
      const ageMs = this.podService.podAgeMs(pod);
      if (ageMs > CRASH_LOOP_RECREATE_AGE_MS) {
        this.logger.warn(`Pod ${podName} stuck in CrashLoopBackOff (age=${ageMs}ms); recreating`);
        await this.safeDeletePod(podName, `CrashLoopBackOff recreate for environment ${env.id}`);
        this.spawnStartupWorker(env.id);
      }
    }

    return { state: 'starting', env };
  }

  private async verifyActiveEnvironment(env: ProjectEnvironmentContext): Promise<EnsureEnvironmentResult> {
    const podName = this.podService.assignedPodName(env.id);
    const pod = await this.readPodOrNull(podName);
    const podIp = pod?.status?.podIP ?? null;

    if (pod && this.podService.isPodReady(pod) && podIp) {
      if (podIp !== env.podIp) {
        await this.projectEnvironmentService.patch(env.id, { podIp }, ProjectStatus.Active);
      }
      return { state: 'ready', env: { ...env, podIp } };
    }

    const startingEnv = await this.requestEnvironmentStartup(env, { deleteExistingPod: !!pod });
    return { state: 'starting', env: startingEnv };
  }

  private async verifyCachedActiveEnvironment(env: ProjectEnvironmentContext): Promise<EnsureEnvironmentResult> {
    const podName = this.podService.assignedPodName(env.id);
    const snapshot = this.podService.getCachedPodSnapshot(podName);
    if (!snapshot.synced) return { state: 'ready', env };

    const pod = snapshot.pod;
    const podIp = pod?.status?.podIP ?? null;
    if (pod && this.podService.isPodReady(pod) && podIp) {
      if (podIp !== env.podIp) {
        await this.projectEnvironmentService.patch(env.id, { podIp }, ProjectStatus.Active);
      }
      return { state: 'ready', env: { ...env, podIp } };
    }

    const startingEnv = await this.requestEnvironmentStartup(env, { deleteExistingPod: !!pod });
    return { state: 'starting', env: startingEnv };
  }

  private async markEnvironmentActive(envId: string, podIp: string, podName: string): Promise<void> {
    const recovery = this.recoveryStartups.delete(envId);

    if (recovery && (await this.timeoutService.isFullyExpired(envId).catch(() => false))) {
      const suspended = await this.projectEnvironmentService.patch(
        envId,
        { status: ProjectStatus.Suspended, podIp: null },
        ProjectStatus.Starting
      );
      if (suspended) {
        this.startupRetries.delete(envId);
        await this.safeDeletePod(podName, `Keep-alive timers expired during recovery of environment ${envId}`);
        this.appReadiness.markDown(envId);
        this.logger.log(`Environment ${envId} suspended after recovery: Keep-alive timers expired during startup`);
        await this.projectEventsService.publish(suspended.projectId).catch(() => {});
        return;
      }
    }

    const [updated] = await db
      .update(projectEnvironments)
      .set({ status: ProjectStatus.Active, podIp, lastActiveAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(projectEnvironments.id, envId),
          eq(projectEnvironments.status, ProjectStatus.Starting),
          sql`exists (select 1 from ${projects} where ${projects.id} = ${projectEnvironments.projectId} and ${projects.disabled} = false)`
        )
      )
      .returning({ projectId: projectEnvironments.projectId, isDefault: projectEnvironments.isDefault });

    if (!updated) {
      this.startupRetries.delete(envId);
      await this.safeDeletePod(podName, `orphan after disable/delete race for environment ${envId}`);
      return;
    }

    this.startupRetries.delete(envId);

    if (updated.isDefault) {
      this.completeDuplicateWhenAppReady(updated.projectId, envId);
      this.completeImportWhenAppReady(updated.projectId, envId);
    }

    await Promise.allSettled([
      recovery
        ? Promise.resolve()
        : this.timeoutService.touch(envId).catch((err) => {
            this.logger.warn(`Failed to touch timeout for environment ${envId}: ${(err as Error).message}`);
          }),
      this.projectEventsService.publish(updated.projectId).catch((err) => {
        this.logger.warn(`Failed to publish active event for environment ${envId}: ${(err as Error).message}`);
      }),
    ]);
    this.logger.log(`Environment ${envId} active on pod ${podName} (${podIp})`);
  }

  private async createBifrostResources(projectId: string, tenantId: string): Promise<void> {
    if (!this.bifrostService.isEnabled()) return;

    try {
      await this.bifrostService.createProjectResources({ projectId, tenantId });
    } catch (err) {
      this.logger.warn(`Failed to create Bifrost resources for project ${projectId}: ${(err as Error).message}`);
    }
  }

  private async createGatewayKeys(
    projectId: string,
    environmentId: string,
    tenantId: string,
    agentId: string,
    createdByProjectId: string | null
  ): Promise<void> {
    try {
      await this.gatewayKeyService.createKey(projectId, environmentId, tenantId);
      if (await this.mintsPlatformApiKey(agentId, createdByProjectId)) {
        await this.gatewayKeyService.createKey(projectId, environmentId, tenantId, 'platform-api');
      }
    } catch (err) {
      this.logger.warn(`Failed to create gateway keys for environment ${environmentId}: ${(err as Error).message}`);
    }
  }

  private async mintsPlatformApiKey(agentId: string, createdByProjectId: string | null): Promise<boolean> {
    if (!(await this.agentService.callsPlatformApi(agentId))) return false;
    return (await this.childChainDepth(createdByProjectId)) < MAX_PROJECT_CHAIN_DEPTH;
  }

  private async childChainDepth(createdByProjectId: string | null): Promise<number> {
    let parentId = createdByProjectId;
    let depth = 0;
    while (parentId !== null && depth < MAX_PROJECT_CHAIN_DEPTH) {
      depth += 1;
      const [row] = await db
        .select({ parentId: projects.createdByProjectId })
        .from(projects)
        .where(eq(projects.id, parentId));
      parentId = row?.parentId ?? null;
    }
    return depth;
  }

  private async enqueueDuplicateJob(data: ProjectDuplicateJobData): Promise<void> {
    await this.duplicateQueue.add('copy', data, {
      jobId: data.duplicateJobId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  private async recoverDuplicateJobs(): Promise<void> {
    const activeJobs = await db
      .select()
      .from(projectDuplicateJobs)
      .where(
        inArray(projectDuplicateJobs.status, [
          ProjectDuplicateStatus.Queued,
          ProjectDuplicateStatus.Committing,
          ProjectDuplicateStatus.Cloning,
          ProjectDuplicateStatus.Copying,
          ProjectDuplicateStatus.Starting,
        ])
      );

    for (const job of activeJobs) {
      if (job.status === ProjectDuplicateStatus.Starting) {
        const env = await this.projectEnvironmentService.findByIdOrNull(job.targetProjectId);
        if (env && env.status === ProjectStatus.Active && env.podIp) {
          this.completeDuplicateWhenAppReady(job.targetProjectId, env.id, true);
        } else {
          this.spawnStartupWorker(job.targetProjectId);
        }
        continue;
      }

      await this.enqueueDuplicateJob({
        duplicateJobId: job.id,
        sourceProjectId: job.sourceProjectId,
        targetProjectId: job.targetProjectId,
      });
    }
  }

  async getLatestDuplicateJob(projectId: string): Promise<ProjectDuplicateJobResponse | null> {
    const [job] = await db
      .select({
        id: projectDuplicateJobs.id,
        status: projectDuplicateJobs.status,
        bytesTotal: projectDuplicateJobs.bytesTotal,
        bytesCopied: projectDuplicateJobs.bytesCopied,
        error: projectDuplicateJobs.error,
        createdAt: projectDuplicateJobs.createdAt,
        updatedAt: projectDuplicateJobs.updatedAt,
      })
      .from(projectDuplicateJobs)
      .where(eq(projectDuplicateJobs.targetProjectId, projectId))
      .orderBy(desc(projectDuplicateJobs.createdAt))
      .limit(1);

    if (!job) return null;

    return {
      id: job.id,
      projectId,
      status: job.status,
      bytesTotal: job.bytesTotal,
      bytesProcessed: job.bytesCopied,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private async hasBlockingDuplicateOperation(projectId: string): Promise<boolean> {
    const [job] = await db
      .select({ id: projectDuplicateJobs.id })
      .from(projectDuplicateJobs)
      .where(
        and(
          eq(projectDuplicateJobs.targetProjectId, projectId),
          inArray(projectDuplicateJobs.status, [
            ProjectDuplicateStatus.Queued,
            ProjectDuplicateStatus.Committing,
            ProjectDuplicateStatus.Cloning,
            ProjectDuplicateStatus.Copying,
            ProjectDuplicateStatus.Failed,
          ])
        )
      );
    return !!job;
  }

  private async assertNoActiveGitOperation(projectId: string, executor: DbExecutor = db): Promise<void> {
    const [publishing] = await executor
      .select({ id: projectPublishJobs.id })
      .from(projectPublishJobs)
      .where(
        and(eq(projectPublishJobs.projectId, projectId), inArray(projectPublishJobs.status, ACTIVE_PUBLISH_STATUSES))
      )
      .limit(1);
    if (publishing) {
      throw new ConflictException('Cannot duplicate while a publish is in progress for this project');
    }

    const [duplicating] = await executor
      .select({ id: projectDuplicateJobs.id })
      .from(projectDuplicateJobs)
      .where(
        and(
          or(eq(projectDuplicateJobs.sourceProjectId, projectId), eq(projectDuplicateJobs.targetProjectId, projectId)),
          inArray(projectDuplicateJobs.status, ACTIVE_DUPLICATE_STATUSES)
        )
      )
      .limit(1);
    if (duplicating) {
      throw new ConflictException('A duplicate is already in progress for this project');
    }
  }

  private completeDuplicateWhenAppReady(projectId: string, envId: string, probeFirst = false): void {
    void (async () => {
      const [job] = await db
        .select({ id: projectDuplicateJobs.id })
        .from(projectDuplicateJobs)
        .where(
          and(
            eq(projectDuplicateJobs.targetProjectId, projectId),
            eq(projectDuplicateJobs.status, ProjectDuplicateStatus.Starting)
          )
        )
        .limit(1);
      if (!job) return;

      if (probeFirst && (await this.probeAppServing(envId))) {
        this.appReadiness.markServing(envId);
      }

      const appReady = await this.appReadiness.awaitReady(envId, DUPLICATE_APP_READY_TIMEOUT_MS);

      const settled = await db
        .update(projectDuplicateJobs)
        .set(
          appReady
            ? { status: ProjectDuplicateStatus.Completed, updatedAt: new Date() }
            : {
                status: ProjectDuplicateStatus.Failed,
                error: "The duplicated app didn't come online in time. Please try again.",
                updatedAt: new Date(),
              }
        )
        .where(
          and(
            eq(projectDuplicateJobs.targetProjectId, projectId),
            eq(projectDuplicateJobs.status, ProjectDuplicateStatus.Starting)
          )
        )
        .returning({ id: projectDuplicateJobs.id });

      if (settled.length > 0) {
        await this.projectEventsService.publish(projectId).catch(() => undefined);
      }
    })().catch((err) => {
      this.logger.warn(`Failed to finish duplicate for project ${projectId}: ${(err as Error).message}`);
    });
  }

  private async hasBlockingImportOperation(projectId: string): Promise<boolean> {
    const [job] = await db
      .select({ id: projectTransferJobs.id })
      .from(projectTransferJobs)
      .where(
        and(
          eq(projectTransferJobs.kind, 'import'),
          eq(projectTransferJobs.projectId, projectId),
          inArray(projectTransferJobs.status, [
            ProjectImportStatus.Queued,
            ProjectImportStatus.Unpacking,
            ProjectImportStatus.Failed,
          ])
        )
      )
      .limit(1);
    return !!job;
  }

  private completeImportWhenAppReady(projectId: string, envId: string, probeFirst = false): void {
    void (async () => {
      const [job] = await db
        .select({ id: projectTransferJobs.id })
        .from(projectTransferJobs)
        .where(
          and(
            eq(projectTransferJobs.kind, 'import'),
            eq(projectTransferJobs.projectId, projectId),
            eq(projectTransferJobs.status, ProjectImportStatus.Starting)
          )
        )
        .limit(1);
      if (!job) return;

      if (probeFirst && (await this.probeAppServing(envId))) {
        this.appReadiness.markServing(envId);
      }

      const appReady = await this.appReadiness.awaitReady(envId, DUPLICATE_APP_READY_TIMEOUT_MS);

      const settled = await db
        .update(projectTransferJobs)
        .set(
          appReady
            ? { status: ProjectImportStatus.Completed, completedAt: new Date(), updatedAt: new Date() }
            : {
                status: ProjectImportStatus.Failed,
                error: "The imported app didn't come online in time. Please try again.",
                completedAt: new Date(),
                updatedAt: new Date(),
              }
        )
        .where(
          and(
            eq(projectTransferJobs.kind, 'import'),
            eq(projectTransferJobs.projectId, projectId),
            eq(projectTransferJobs.status, ProjectImportStatus.Starting)
          )
        )
        .returning({ id: projectTransferJobs.id });

      if (settled.length > 0) {
        await this.projectEventsService.publish(projectId).catch(() => undefined);
        if (!appReady) await this.discardHalfCreatedProject(projectId);
      }
    })().catch((err) => {
      this.logger.warn(`Failed to finish import for project ${projectId}: ${(err as Error).message}`);
    });
  }

  private async recoverImportJobs(): Promise<void> {
    const activeJobs = await db
      .select()
      .from(projectTransferJobs)
      .where(and(eq(projectTransferJobs.kind, 'import'), inArray(projectTransferJobs.status, ACTIVE_IMPORT_STATUSES)));

    for (const job of activeJobs) {
      if (job.status === ProjectImportStatus.Starting) {
        const env = await this.projectEnvironmentService.findByIdOrNull(job.projectId);
        if (env && env.status === ProjectStatus.Active && env.podIp) {
          this.completeImportWhenAppReady(job.projectId, env.id, true);
        } else {
          this.spawnStartupWorker(job.projectId);
        }
        continue;
      }

      await db
        .update(projectTransferJobs)
        .set({
          status: ProjectImportStatus.Failed,
          error: 'Import interrupted by a server restart',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectTransferJobs.id, job.id));
      await this.projectEventsService.publish(job.projectId).catch(() => undefined);
      await this.discardHalfCreatedProject(job.projectId);
    }
  }

  /** Unwinds a Project whose creation or Import failed: its rows, its keys and its directory. */
  async discardHalfCreatedProject(projectId: string): Promise<void> {
    const project = await this.findOneById(projectId).catch(() => null);
    if (!project || !project.tenantId) return;

    const storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    const projectDir = path.join(storageMountPath, project.directory);

    await this.remove(projectId, project.tenantId).catch((err) => {
      this.logger.warn(`Failed to remove project ${projectId} during import cleanup: ${(err as Error).message}`);
    });
    await rm(projectDir, { recursive: true, force: true }).catch((err) => {
      this.logger.warn(
        `Failed to remove project directory ${projectDir} during import cleanup: ${(err as Error).message}`
      );
    });
  }

  private async probeAppServing(envId: string): Promise<boolean> {
    try {
      const upstream = await this.proxyService.resolveAppUpstreamByEnvironmentId(envId);
      await fetch(`${upstream}/`, {
        signal: AbortSignal.timeout(APP_SERVING_PROBE_TIMEOUT_MS),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async requestEnvironmentStartup(
    env: ProjectEnvironmentContext,
    options: { deleteExistingPod: boolean }
  ): Promise<ProjectEnvironmentContext> {
    this.agentStatusService.clear(env.projectId, env.id);

    if (env.status === ProjectStatus.Starting) {
      if (options.deleteExistingPod) {
        const podName = this.podService.assignedPodName(env.id);
        this.recreateRequests.add(env.id);
        await this.safeDeletePod(podName, `restart for environment ${env.id}`);
      }
      this.spawnStartupWorker(env.id);
      return env;
    }

    const updated = await this.projectEnvironmentService.patch(
      env.id,
      { status: ProjectStatus.Starting, podIp: null },
      [ProjectStatus.Active, ProjectStatus.Suspended, ProjectStatus.Failed]
    );

    if (!updated) {
      const current = await this.projectEnvironmentService.findById(env.id);
      if (current.status === ProjectStatus.Starting) {
        this.spawnStartupWorker(current.id);
      }
      return current;
    }

    if (options.deleteExistingPod) {
      const podName = this.podService.assignedPodName(env.id);
      this.recreateRequests.add(env.id);
      await this.safeDeletePod(podName, `restart for environment ${env.id}`);
    }

    this.spawnStartupWorker(env.id);
    await this.projectEventsService.publish(env.projectId);

    return this.projectEnvironmentService.findById(env.id);
  }

  private spawnStartupWorker(envId: string): void {
    if (this.startupTasks.has(envId)) return;
    const task = this.runStartup(envId)
      .catch((err) => {
        this.recoveryStartups.delete(envId);
        this.logger.warn(`Startup worker for environment ${envId} crashed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.startupTasks.delete(envId);
      });
    this.startupTasks.set(envId, task);
  }

  private async runStartup(envId: string): Promise<void> {
    const current = await this.projectEnvironmentService.findByIdOrNull(envId).catch(() => null);
    if (!current || current.status !== ProjectStatus.Starting) {
      this.recoveryStartups.delete(envId);
      return;
    }
    if (current.disabled) {
      this.recoveryStartups.delete(envId);
      this.startupRetries.delete(envId);
      await this.projectEnvironmentService.patch(
        envId,
        { status: ProjectStatus.Suspended, podIp: null },
        ProjectStatus.Starting
      );
      return;
    }
    if (current.isDefault && (await this.hasBlockingDuplicateOperation(current.projectId))) {
      this.recoveryStartups.delete(envId);
      return;
    }
    if (current.isDefault && (await this.hasBlockingImportOperation(current.projectId))) {
      this.recoveryStartups.delete(envId);
      return;
    }

    const podName = this.podService.assignedPodName(envId);
    const recreateRequested = this.recreateRequests.delete(envId);
    const existingPod = await this.readPodOrNull(podName);
    if (existingPod && !existingPod.metadata?.deletionTimestamp) {
      if (recreateRequested) {
        try {
          await this.podService.deletePod(podName);
        } catch (err) {
          await this.handleStartupFailure(envId, podName, err);
          return;
        }
      } else {
        const existingPodIp = existingPod.status?.podIP ?? null;
        if (this.podService.isPodReady(existingPod) && existingPodIp) {
          await this.markEnvironmentActive(envId, existingPodIp, podName);
          return;
        }

        const failure = this.podService.inspectFailureReason(existingPod);
        if (failure === 'ImagePullBackOff') {
          await this.handleStartupFailure(
            envId,
            podName,
            new PodStartupFailedError(podName, failure, this.podService.inspectFailureMessage(existingPod))
          );
          return;
        }
        if (failure === 'Unschedulable' && this.podService.podAgeMs(existingPod) > UNSCHEDULABLE_STARTUP_GRACE_MS) {
          await this.handleStartupFailure(
            envId,
            podName,
            new PodStartupFailedError(podName, failure, this.podService.inspectFailureMessage(existingPod))
          );
          return;
        }

        if (failure !== 'CrashLoopBackOff' || this.podService.podAgeMs(existingPod) <= CRASH_LOOP_RECREATE_AGE_MS) {
          try {
            const podIp = await this.podService.waitForReady(podName);
            await this.markEnvironmentActive(envId, podIp, podName);
          } catch (err) {
            await this.handleStartupFailure(envId, podName, err);
          }
          return;
        }

        await this.safeDeletePod(podName, `CrashLoopBackOff recreate for environment ${envId}`);
      }
    }

    if (!current.tenantId) {
      this.logger.warn(`runStartup invoked for pool environment ${envId}; skipping`);
      return;
    }

    try {
      await this.spawnPodForEnvironment(current);
      const podIp = await this.podService.waitForReady(podName);
      await this.markEnvironmentActive(envId, podIp, podName);
    } catch (err) {
      await this.handleStartupFailure(envId, podName, err);
    }
  }

  private async spawnPodForEnvironment(env: ProjectEnvironmentContext): Promise<void> {
    if (!env.tenantId) {
      throw new Error(`Cannot start pool environment ${env.id} without a tenant`);
    }

    const [bifrostOptions, gatewayApiKey, platformApiKey, agentName, podResources] = await Promise.all([
      this.bifrostService.getEnvironmentPodOptions(env.id),
      this.gatewayKeyService.getEnvironmentToken(env.id),
      this.gatewayKeyService.getEnvironmentToken(env.id, 'platform-api'),
      this.agentService.resolvePackageName(env.agentId),
      this.podResourcesForProject(env.projectId),
    ]);

    if (this.bifrostService.isEnabled() && !bifrostOptions) {
      throw new Error(
        `No active LLM virtual keys for environment ${env.id}; refusing to start pod without credentials`
      );
    }

    const platformApiUrl = this.configService.get<string>('platformApiUrl', '');
    const runtimeProxyUrl = this.configService.get<string>('runtimeProxyUrl', '');

    if (platformApiKey && !(platformApiUrl && runtimeProxyUrl)) {
      throw new Error(
        `Environment ${env.id} holds a platform-api key but OPSIFORCE_API_URL or OPSIFORCE_RUNTIME_PROXY_URL is unset; ` +
          'refusing to start a pod that cannot reach the platform API'
      );
    }

    const tenantOptions = {
      ...bifrostOptions,
      agentName,
      gatewayApiKey: gatewayApiKey ?? undefined,
      gatewayUrl: this.configService.get<string>('gatewayUrl', ''),
      platformApiKey: platformApiKey ?? undefined,
      platformApiUrl,
      runtimeProxyUrl,
      externalServicesUrl: this.configService.get<string>('externalServicesUrl', ''),
      opsiforceEnv: env.isDefault ? undefined : 'production',
      environmentSlug: env.environmentSlug,
      resources: podResources,
      controlToken: crypto.randomBytes(32).toString('hex'),
    };

    const { created } = await this.podService.createAssignedPod(env.id, env.directory, env.projectId, tenantOptions);
    if (created) this.appReadiness.markDown(env.id);
  }

  private async handleStartupFailure(envId: string, podName: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : 'Project pod failed to start';
    const isPermanentFailure =
      err instanceof PodStartupFailedError && (err.reason === 'ImagePullBackOff' || err.reason === 'Unschedulable');

    this.logger.warn(`Startup failed for environment ${envId}: ${message}`);

    const env = await this.projectEnvironmentService.findByIdOrNull(envId).catch(() => null);

    const projectId = env?.projectId ?? envId;

    const duplicateFailUpdate = isPermanentFailure
      ? db
          .update(projectDuplicateJobs)
          .set({ status: ProjectDuplicateStatus.Failed, error: message, updatedAt: new Date() })
          .where(
            and(
              eq(projectDuplicateJobs.targetProjectId, projectId),
              eq(projectDuplicateJobs.status, ProjectDuplicateStatus.Starting)
            )
          )
      : Promise.resolve();

    await Promise.allSettled([
      isPermanentFailure ? Promise.resolve() : this.safeDeletePod(podName, `startup failure for environment ${envId}`),
      duplicateFailUpdate,
      this.projectEventsService.publish(projectId).catch((publishErr) => {
        this.logger.warn(`Failed to publish startup failure event for ${envId}: ${(publishErr as Error).message}`);
      }),
    ]);

    if (isPermanentFailure) {
      this.startupRetries.delete(envId);
      this.agentStatusService.clear(projectId, envId);
      this.recoveryStartups.delete(envId);
      await this.projectEnvironmentService.patch(
        envId,
        { status: ProjectStatus.Failed, podIp: null },
        ProjectStatus.Starting
      );
      await this.projectEventsService.publish(projectId).catch(() => {});
      return;
    }

    if (this.recoveryStartups.has(envId) && (await this.timeoutService.isFullyExpired(envId).catch(() => false))) {
      const suspended = await this.projectEnvironmentService.patch(
        envId,
        { status: ProjectStatus.Suspended, podIp: null },
        ProjectStatus.Starting
      );
      if (suspended) {
        this.recoveryStartups.delete(envId);
        this.startupRetries.delete(envId);
        this.appReadiness.markDown(envId);
        this.logger.log(`Environment ${envId} suspended after recovery: Keep-alive timers expired during startup`);
        await this.projectEventsService.publish(suspended.projectId).catch(() => {});
        return;
      }
    }

    const attempts = (this.startupRetries.get(envId) ?? 0) + 1;
    this.startupRetries.set(envId, attempts);
    const delay = Math.min(STARTUP_RETRY_BASE_MS * Math.pow(2, attempts - 1), STARTUP_RETRY_MAX_MS);
    this.logger.warn(`Scheduling retry ${attempts} for environment ${envId} in ${delay}ms`);
    setTimeout(() => {
      this.spawnStartupWorker(envId);
    }, delay);
  }

  private async safeDeletePod(podName: string, context: string): Promise<void> {
    await this.podService.deletePod(podName).catch((err) => {
      this.logger.warn(`Failed to delete pod ${podName} (${context}): ${(err as Error).message}`);
    });
  }

  private async readPodOrNull(podName: string) {
    try {
      return await this.podService.getPod(podName);
    } catch (err) {
      if (this.podService.isNotFound(err)) return null;
      throw err;
    }
  }

  private recordActivity(envId: string, activity: ProjectActivityKind) {
    void this.touchEnvironmentActivity(envId, activity).catch((err) => {
      this.logger.warn(`Failed to touch ${activity} activity for environment ${envId}: ${err.message}`);
    });
  }
}
