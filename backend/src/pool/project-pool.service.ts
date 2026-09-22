import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, forwardRef } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '../../db';
import {
  agents,
  projectEnvironments,
  projectGatewayKeys,
  projectPodSettings,
  projectSettings,
  projectVirtualKeys,
  projects,
  tenants,
} from '../../db/schema';
import { resolvePreset } from '../pod/pod-classes';
import { ProjectStatus, type ProjectKind } from '../project/project.types';
import { PodService } from '../pod/pod.service';
import { BifrostService } from '../bifrost/bifrost.service';
import { GatewayKeyService } from '../gateway/gateway-key.service';
import { DefaultsService } from '../defaults/defaults.service';
import { TimeoutService } from '../timeout/timeout.service';
import { EnvironmentService } from '../environment/environment.service';
import { ExternalServiceProvisioningService } from '../external-services';
import { agentDeclaresPlatformApi, type AgentModelSelection } from '../agent/agent-config';
import { AgentReconcilerService } from '../agent/agent-reconciler.service';
import { DeliveryService } from '../delivery/delivery.service';
import {
  PROJECT_POOL_QUEUE,
  PROJECT_POOL_TEARDOWN_QUEUE,
  ProjectPoolJob,
  type ProjectPoolJobData,
  type TeardownJobData,
} from './project-pool.types';

const POOL_LEGACY_WARM_SELECTOR = 'app=opsiforce-agent,opsiforce.io/pool=warm';
const STALE_CLAIMING_MS = 30 * 1000;
const RECOVERY_INTERVAL_MS = 60 * 1000;
const PATCH_BACKOFF_MS = [500, 1000, 2000];
const STALE_PENDING_POD_MS = 90 * 1000;
const POOL_PROVISION_READY_TIMEOUT_MS = 90 * 1000;

export interface PoolClaim {
  tenantId: string;
  workspaceId: string | null;
  folderId: string | null;
  title: string | null;
  description: string | null;
  timeoutIdle: number;
  appTimeoutIdle: number;
  timezone: string;
  createdBy: string | null;
  createdByProjectId: string | null;
  kind: ProjectKind | null;
}

interface PendingRow {
  id: string;
  directory: string;
  bifrostProjectId: string | null;
  agentId: string;
}

type TeamPatchResult = 'patched' | 'clean-failed' | 'dirty';

@Injectable()
export class ProjectPoolService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ProjectPoolService.name);
  private readonly platformVersion: string;
  private readonly gatewayUrl: string;
  private readonly externalServicesUrl: string;
  private readonly storageMountPath: string;
  private readonly poolSizeOverride: number | null;
  private agentTargetByName = new Map<string, number>();
  private agentVersionByName = new Map<string, string>();
  private agentModelSelectionByName = new Map<string, AgentModelSelection>();
  private readonly agentIdToName = new Map<string, string>();
  private readonly agentNameToId = new Map<string, string>();
  private integrityTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectQueue(PROJECT_POOL_QUEUE)
    private readonly queue: Queue<ProjectPoolJobData>,
    @InjectQueue(PROJECT_POOL_TEARDOWN_QUEUE)
    private readonly teardownQueue: Queue<TeardownJobData>,
    private readonly podService: PodService,
    @Inject(forwardRef(() => BifrostService))
    private readonly bifrostService: BifrostService,
    private readonly gatewayKeyService: GatewayKeyService,
    private readonly defaultsService: DefaultsService,
    private readonly timeoutService: TimeoutService,
    private readonly environmentService: EnvironmentService,
    private readonly externalServiceProvisioning: ExternalServiceProvisioningService,
    private readonly configService: ConfigService,
    private readonly agentReconciler: AgentReconcilerService,
    private readonly deliveryService: DeliveryService
  ) {
    this.platformVersion = this.configService.get<string>('platformVersion', '0.1.0');
    this.gatewayUrl = this.configService.get<string>('gatewayUrl', '');
    this.externalServicesUrl = this.configService.get<string>('externalServicesUrl', '');
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.poolSizeOverride = this.configService.get<number | null>('poolSizeOverride', null);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.cacheAgentIds();
    await this.queue.setGlobalConcurrency(1).catch((err) => {
      this.logger.warn(`Failed to set global pool queue concurrency: ${(err as Error).message}`);
    });

    await this.sweepLegacyWarmPods().catch((err) => {
      this.logger.warn(`Legacy warm pod sweep failed: ${(err as Error).message}`);
    });

    await this.enqueueIntegrity('boot').catch((err) => {
      this.logger.warn(`Failed to enqueue boot integrity job: ${(err as Error).message}`);
    });

    this.integrityTimer = setInterval(() => {
      void this.enqueueIntegrity('interval').catch((err) => {
        this.logger.warn(`Failed to enqueue periodic integrity job: ${(err as Error).message}`);
      });
    }, RECOVERY_INTERVAL_MS);
    this.integrityTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.integrityTimer) clearInterval(this.integrityTimer);
  }

  async claimPending(agentId: string, claim: PoolClaim): Promise<string | null> {
    const name = this.agentIdToName.get(agentId);
    if (!name) return null;
    if (agentDeclaresPlatformApi(name)) return null;

    const reserved = await this.reservePending(agentId, claim);
    if (!reserved) return null;

    const livePodIp = await this.readReadyPodIp(reserved.id);
    if (!livePodIp) {
      this.logger.warn(
        `Pool slot ${reserved.id} has no ready pod at claim time; tearing it down and falling back to slow path`
      );
      await this.destroyPoolSlot(reserved.id, [ProjectStatus.Claiming], 'unhealthy pod at claim').catch((err) => {
        this.logger.warn(`Inline teardown of ${reserved.id} failed: ${(err as Error).message}`);
      });
      await this.replenishIfEnabled(name, reserved.agentId);
      return null;
    }

    let customerId: string;
    try {
      customerId = await this.ensureTenantCustomer(claim.tenantId);
    } catch (err) {
      this.logger.warn(
        `Failed to resolve Bifrost customer for tenant ${claim.tenantId} during claim ${reserved.id}: ${(err as Error).message}`
      );
      await this.revertReservation(reserved.id);
      return null;
    }

    const budgetsPatched = await this.patchBifrostBudgetsWithRetries(
      reserved.id,
      reserved.bifrostProjectId,
      claim.tenantId
    );
    if (!budgetsPatched) {
      this.logger.warn(`Reverting claim ${reserved.id}: Bifrost budget patch failed permanently`);
      await this.revertReservation(reserved.id);
      return null;
    }

    const patched = await this.patchBifrostTeamWithRetries(reserved.bifrostProjectId, customerId);
    if (patched !== 'patched') {
      this.logger.warn(`Reverting claim ${reserved.id}: Bifrost team patch failed permanently`);
      if (patched === 'clean-failed') {
        await this.revertReservation(reserved.id);
      } else {
        await this.destroyPoolSlot(reserved.id, [ProjectStatus.Claiming], 'bifrost patch outcome unknown').catch(
          () => {}
        );
        await this.replenishIfEnabled(name, reserved.agentId);
      }
      return null;
    }

    const delivered = await this.deliveryService.deliverAtCreate(reserved.id).then(
      () => true,
      (err: Error) => {
        this.logger.warn(`Claim ${reserved.id} could not receive its agent files: ${err.message}`);
        return false;
      }
    );
    if (!delivered) {
      await this.destroyPoolSlot(reserved.id, [ProjectStatus.Claiming], 'delivery failed').catch(() => {});
      await this.replenishIfEnabled(name, reserved.agentId);
      return null;
    }

    const finalized = await this.finalizeClaim(reserved.id, claim, livePodIp).catch(() => false);
    if (!finalized) {
      const [check] = await db
        .select({ status: projectEnvironments.status, tenantId: projects.tenantId })
        .from(projects)
        .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
        .where(eq(projects.id, reserved.id));
      if (check?.status === ProjectStatus.Active && check.tenantId === claim.tenantId) {
        return reserved.id;
      }
      this.logger.warn(`Claim ${reserved.id} could not be finalized; tearing it down and falling back`);
      await this.destroyPoolSlot(reserved.id, [ProjectStatus.Claiming], 'finalize failed').catch(() => {});
      await this.replenishIfEnabled(name, reserved.agentId);
      return null;
    }

    await this.replenishIfEnabled(name, reserved.agentId);
    return reserved.id;
  }

  private async replenishIfEnabled(agentName: string, agentId: string): Promise<void> {
    if (this.effectiveTarget(agentName) <= 0) return;
    await this.enqueueReplenish(agentId).catch((err) => {
      this.logger.warn(`Post-claim replenish enqueue failed for ${agentId}: ${(err as Error).message}`);
    });
  }

  async runReplenishJob(agentId: string): Promise<void> {
    const name = this.agentIdToName.get(agentId);
    if (!name) return;
    const target = this.effectiveTarget(name);
    if (target === 0) return;

    let current = await this.countPoolSlots(agentId);
    let deficit = target - current;
    if (deficit <= 0) return;

    this.logger.log(`Replenishing pool for ${name}: deficit=${deficit} (target=${target}, current=${current})`);

    let guard = 0;
    const maxIterations = target + 2;
    while (deficit > 0 && guard < maxIterations) {
      guard++;
      try {
        await this.createPendingProject(agentId, name);
      } catch (err) {
        this.logger.warn(`Failed to create pending project for ${name}: ${(err as Error).message}`);
      }
      current = await this.countPoolSlots(agentId);
      deficit = target - current;
    }
  }

  async runRecycleJob(projectId: string, reason: string): Promise<void> {
    const agentId = await this.destroyPoolSlot(projectId, [ProjectStatus.Pending], reason);
    if (!agentId) return;
    await this.enqueueReplenish(agentId).catch((err) => {
      this.logger.warn(`Replenish after recycle failed for ${agentId}: ${(err as Error).message}`);
    });
  }

  async runTeardownJob(data: TeardownJobData): Promise<void> {
    await this.teardownExternalResources(data);
  }

  async runIntegrityJob(triggeredBy: 'boot' | 'interval'): Promise<void> {
    await this.cacheAgentIds();
    await this.recoverClaimingRows();
    await this.reconcilePendingPods();
    await this.enqueueDeficitReplenishes();
    if (triggeredBy === 'boot') this.logger.log('Boot pool integrity reconciliation complete');
  }

  private async enqueueReplenish(agentId: string): Promise<void> {
    await this.queue.add(ProjectPoolJob.Replenish, { agentId }, { removeOnComplete: true, removeOnFail: true });
  }

  private async enqueueRecycle(projectId: string, reason: string): Promise<void> {
    await this.queue.add(
      ProjectPoolJob.Recycle,
      { projectId, reason },
      { jobId: `recycle__${projectId}`, removeOnComplete: true, removeOnFail: true }
    );
  }

  private async enqueueTeardown(data: TeardownJobData): Promise<void> {
    await this.teardownQueue.add(ProjectPoolJob.Teardown, data, {
      jobId: `teardown__${data.projectId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  private async enqueueIntegrity(triggeredBy: 'boot' | 'interval'): Promise<void> {
    const bucket = Math.floor(Date.now() / RECOVERY_INTERVAL_MS);
    await this.queue.add(
      ProjectPoolJob.Integrity,
      { triggeredBy },
      { jobId: `integrity__${bucket}`, removeOnComplete: true, removeOnFail: true }
    );
  }

  private async enqueueDeficitReplenishes(): Promise<void> {
    for (const [name, agentId] of this.agentNameToId.entries()) {
      const target = this.effectiveTarget(name);
      if (target === 0) continue;
      const current = await this.countPoolSlots(agentId);
      if (current < target) await this.enqueueReplenish(agentId);
    }
  }

  private async reservePending(agentId: string, claim: PoolClaim): Promise<PendingRow | null> {
    const defaultEnvironment = await this.environmentService.ensureDefaultForTenant(claim.tenantId);

    return db.transaction(async (tx) => {
      const reserved = await tx
        .select({
          id: projects.id,
          directory: projectEnvironments.directory,
          bifrostProjectId: projects.bifrostProjectId,
          agentId: projects.agentId,
        })
        .from(projects)
        .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
        .where(
          and(
            eq(projectEnvironments.status, ProjectStatus.Pending),
            eq(projects.agentId, agentId),
            isNotNull(projectEnvironments.podIp)
          )
        )
        .orderBy(asc(projects.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });

      const row = reserved[0];
      if (!row) return null;

      await tx
        .update(projects)
        .set({
          tenantId: claim.tenantId,
          workspaceId: claim.workspaceId,
          folderId: claim.folderId,
          title: claim.title,
          description: claim.description,
          createdBy: claim.createdBy,
          createdByProjectId: claim.createdByProjectId,
          kind: claim.kind,
          lastPromptAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projects.id, row.id));

      await tx
        .update(projectEnvironments)
        .set({ status: ProjectStatus.Claiming, environmentId: defaultEnvironment.id, updatedAt: new Date() })
        .where(eq(projectEnvironments.id, row.id));

      await tx
        .update(projectSettings)
        .set({
          timeoutIdle: claim.timeoutIdle,
          appTimeoutIdle: claim.appTimeoutIdle,
          timezone: claim.timezone,
        })
        .where(eq(projectSettings.projectId, row.id));

      return row;
    });
  }

  private async finalizeClaim(projectId: string, claim: PoolClaim, podIp: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: projectEnvironments.status })
        .from(projectEnvironments)
        .where(eq(projectEnvironments.id, projectId))
        .for('update');
      if (!row || row.status !== ProjectStatus.Claiming) return false;

      await tx
        .update(projectVirtualKeys)
        .set({ tenantId: claim.tenantId, updatedAt: new Date() })
        .where(eq(projectVirtualKeys.projectId, projectId));

      await tx
        .update(projectGatewayKeys)
        .set({ tenantId: claim.tenantId, updatedAt: new Date() })
        .where(eq(projectGatewayKeys.projectId, projectId));

      await tx
        .update(projectSettings)
        .set({
          timeoutIdle: claim.timeoutIdle,
          appTimeoutIdle: claim.appTimeoutIdle,
          timezone: claim.timezone,
        })
        .where(eq(projectSettings.projectId, projectId));

      await tx
        .update(projectEnvironments)
        .set({
          status: ProjectStatus.Active,
          podIp,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectEnvironments.id, projectId));

      return true;
    });
  }

  private async revertReservation(projectId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [env] = await tx
        .select({ status: projectEnvironments.status })
        .from(projectEnvironments)
        .where(eq(projectEnvironments.id, projectId))
        .for('update');
      if (!env || env.status !== ProjectStatus.Claiming) return;

      await tx
        .update(projects)
        .set({
          tenantId: null,
          workspaceId: null,
          folderId: null,
          title: null,
          description: null,
          createdBy: null,
          createdByProjectId: null,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));

      await tx
        .update(projectEnvironments)
        .set({ status: ProjectStatus.Pending, environmentId: null, updatedAt: new Date() })
        .where(eq(projectEnvironments.id, projectId));
    });
  }

  private async patchBifrostBudgetsWithRetries(
    projectId: string,
    teamId: string | null,
    tenantId: string
  ): Promise<boolean> {
    if (!this.bifrostService.isEnabled()) return true;
    if (!teamId) {
      this.logger.warn('Pool project has no bifrost team id; cannot patch budgets');
      return false;
    }

    const budgets = await this.defaultsService.getTenantBudgets(tenantId);
    for (let attempt = 0; attempt < PATCH_BACKOFF_MS.length; attempt++) {
      try {
        await this.bifrostService.updateProjectResourceBudgets(projectId, teamId, budgets);
        return true;
      } catch (err) {
        const delay = PATCH_BACKOFF_MS[attempt];
        this.logger.warn(
          `Bifrost budget patch attempt ${attempt + 1} failed (project=${projectId}): ${(err as Error).message}; retrying in ${delay}ms`
        );
        if (attempt < PATCH_BACKOFF_MS.length - 1) await sleep(delay);
      }
    }

    return false;
  }

  private async patchBifrostTeamWithRetries(teamId: string | null, customerId: string): Promise<TeamPatchResult> {
    if (!this.bifrostService.isEnabled()) return 'patched';
    if (!teamId) {
      this.logger.warn('Pool project has no bifrost team id; cannot patch customer assignment');
      return 'dirty';
    }

    for (let attempt = 0; attempt < PATCH_BACKOFF_MS.length; attempt++) {
      try {
        await this.bifrostService.reassignTeamCustomer(teamId, customerId);
        return 'patched';
      } catch (err) {
        const delay = PATCH_BACKOFF_MS[attempt];
        this.logger.warn(
          `Bifrost team patch attempt ${attempt + 1} failed (team=${teamId}): ${(err as Error).message}; retrying in ${delay}ms`
        );
        if (attempt < PATCH_BACKOFF_MS.length - 1) await sleep(delay);
      }
    }

    try {
      const assignedCustomerId = await this.bifrostService.getTeamCustomerId(teamId);
      if (assignedCustomerId === customerId) return 'patched';
      return assignedCustomerId ? 'dirty' : 'clean-failed';
    } catch (err) {
      this.logger.warn(`Unable to verify Bifrost team ${teamId} after failed patch: ${(err as Error).message}`);
      return 'dirty';
    }
  }

  private async ensureTenantCustomer(tenantId: string): Promise<string> {
    if (!this.bifrostService.isEnabled()) return '';
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    if (tenant.bifrostTenantId) return tenant.bifrostTenantId;
    const budgets = await this.defaultsService.getTenantBudgets(tenantId);
    return this.bifrostService.createTenantCustomer(tenantId, tenant.name, budgets);
  }

  private async createPendingProject(agentId: string, agentName: string): Promise<void> {
    const id = crypto.randomUUID();
    const directory = `projects/${id}`;
    const timeouts = await this.defaultsService.getGlobalTimeouts();

    await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id,
        tenantId: null,
        workspaceId: null,
        agentId,
        title: null,
        description: null,
      });

      await tx.insert(projectSettings).values({
        projectId: id,
        timeoutIdle: timeouts.defaultTimeoutIdle,
        appTimeoutIdle: timeouts.defaultAppTimeoutIdle,
        timezone: 'UTC',
      });

      await tx.insert(projectPodSettings).values({
        projectId: id,
        podClass: 'small',
        ...resolvePreset('small'),
      });

      await tx.insert(projectEnvironments).values({
        id,
        projectId: id,
        environmentId: null,
        isDefault: true,
        directory,
        status: ProjectStatus.Pending,
        platformVersion: this.platformVersion,
      });
    });

    await this.externalServiceProvisioning.provisionEnvironment(id);

    try {
      if (this.bifrostService.isEnabled()) {
        await this.bifrostService.createOrphanProjectResources({ projectId: id });
      }
      await this.gatewayKeyService.createKey(id, id, null);

      const [bifrostOptions, gatewayApiKey] = await Promise.all([
        this.bifrostService.getEnvironmentPodOptions(id),
        this.gatewayKeyService.getEnvironmentToken(id),
      ]);

      await this.podService.createAssignedPod(id, directory, id, {
        ...bifrostOptions,
        agentName,
        gatewayApiKey: gatewayApiKey ?? undefined,
        gatewayUrl: this.gatewayUrl,
        externalServicesUrl: this.externalServicesUrl,
        controlToken: crypto.randomBytes(32).toString('hex'),
      });

      const podName = this.podService.assignedPodName(id);
      const podIp = await this.podService.waitForReady(podName, POOL_PROVISION_READY_TIMEOUT_MS);
      await db
        .update(projectEnvironments)
        .set({ podIp, updatedAt: new Date() })
        .where(and(eq(projectEnvironments.id, id), eq(projectEnvironments.status, ProjectStatus.Pending)));
      this.logger.log(`Pool project ${id} ready (agent=${agentName})`);
    } catch (err) {
      this.logger.warn(`Failed to provision pool project ${id}: ${(err as Error).message}`);
      await this.destroyPoolSlot(id, [ProjectStatus.Pending], 'provisioning failed').catch(() => {});
      throw err;
    }
  }

  private async destroyPoolSlot(
    projectId: string,
    expectedStatuses: ProjectStatus[],
    reason: string
  ): Promise<string | null> {
    const captured = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          status: projectEnvironments.status,
          bifrostProjectId: projects.bifrostProjectId,
          agentId: projects.agentId,
          directory: projectEnvironments.directory,
        })
        .from(projects)
        .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
        .where(eq(projects.id, projectId))
        .for('update');
      if (!row || !expectedStatuses.includes(row.status as ProjectStatus)) return null;

      const vks = await tx
        .select({ bifrostKeyId: projectVirtualKeys.bifrostKeyId })
        .from(projectVirtualKeys)
        .where(eq(projectVirtualKeys.projectId, projectId));

      await tx.delete(projects).where(eq(projects.id, projectId));
      return {
        bifrostProjectId: row.bifrostProjectId,
        keyIds: vks.map((v) => v.bifrostKeyId),
        agentId: row.agentId,
        directory: row.directory,
      };
    });

    if (!captured) return null;

    this.logger.warn(`Destroyed pool slot ${projectId} (reason=${reason})`);
    const teardown = {
      projectId,
      bifrostProjectId: captured.bifrostProjectId,
      bifrostKeyIds: captured.keyIds,
      podName: this.podService.assignedPodName(projectId),
      directory: captured.directory,
    };
    await this.enqueueTeardown(teardown).catch(async (err) => {
      this.logger.warn(`Failed to enqueue teardown for ${projectId}: ${(err as Error).message}`);
      await this.teardownExternalResources(teardown).catch((teardownErr) => {
        this.logger.warn(`Inline teardown failed for ${projectId}: ${(teardownErr as Error).message}`);
      });
    });
    return captured.agentId;
  }

  private async teardownExternalResources(data: TeardownJobData): Promise<void> {
    await this.podService.deletePod(data.podName);
    if (this.bifrostService.isEnabled()) {
      await this.bifrostService.destroyTeamAndKeys(data.bifrostProjectId, data.bifrostKeyIds);
    }
    await rm(join(this.storageMountPath, data.directory), { recursive: true, force: true });
  }

  private async recoverClaimingRows(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_CLAIMING_MS);
    const stale = await db
      .select({
        id: projects.id,
        tenantId: projects.tenantId,
        bifrostProjectId: projects.bifrostProjectId,
      })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(and(eq(projectEnvironments.status, ProjectStatus.Claiming), lt(projectEnvironments.updatedAt, cutoff)));

    for (const row of stale) {
      if (!row.tenantId) {
        this.logger.warn(`Recovery: claiming row ${row.id} has null tenant_id; reverting`);
        await this.revertReservation(row.id);
        continue;
      }
      try {
        const customerId = await this.ensureTenantCustomer(row.tenantId);
        const budgetsPatched = await this.patchBifrostBudgetsWithRetries(row.id, row.bifrostProjectId, row.tenantId);
        if (!budgetsPatched) {
          await this.destroyAndReplenish(row.id, 'recovery: bifrost budget patch failed permanently');
          continue;
        }
        const patched = await this.patchBifrostTeamWithRetries(row.bifrostProjectId, customerId);
        if (patched !== 'patched') {
          await this.destroyAndReplenish(row.id, 'recovery: bifrost patch failed permanently');
          continue;
        }
        await this.deliveryService.deliverAtCreate(row.id);
        const finalized = await this.finalizeRecoveredClaim(row.id, row.tenantId);
        if (finalized) {
          await this.timeoutService.touch(row.id).catch((err) => {
            this.logger.warn(`Recovery: failed to start idle timeout for ${row.id}: ${(err as Error).message}`);
          });
          this.logger.log(`Recovery: finalized stuck claim ${row.id}`);
        }
      } catch (err) {
        this.logger.warn(`Recovery for claim ${row.id} failed: ${(err as Error).message}`);
        await this.destroyAndReplenish(row.id, 'recovery: error during delivery or finalize').catch(() => {});
      }
    }
  }

  private async destroyAndReplenish(projectId: string, reason: string): Promise<void> {
    const agentId = await this.destroyPoolSlot(projectId, [ProjectStatus.Claiming, ProjectStatus.Pending], reason);
    if (agentId) await this.enqueueReplenish(agentId).catch(() => {});
  }

  private async finalizeRecoveredClaim(projectId: string, tenantId: string): Promise<boolean> {
    const timeouts = await this.defaultsService.getTenantTimeouts(tenantId);
    const podIp = await this.readReadyPodIp(projectId);

    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: projectEnvironments.status })
        .from(projectEnvironments)
        .where(eq(projectEnvironments.id, projectId))
        .for('update');
      if (!row || row.status !== ProjectStatus.Claiming) return false;

      await tx
        .update(projectVirtualKeys)
        .set({ tenantId, updatedAt: new Date() })
        .where(eq(projectVirtualKeys.projectId, projectId));

      await tx
        .update(projectGatewayKeys)
        .set({ tenantId, updatedAt: new Date() })
        .where(eq(projectGatewayKeys.projectId, projectId));

      await tx
        .update(projectSettings)
        .set({
          timeoutIdle: timeouts.defaultTimeoutIdle,
          appTimeoutIdle: timeouts.defaultAppTimeoutIdle,
        })
        .where(eq(projectSettings.projectId, projectId));

      await tx
        .update(projectEnvironments)
        .set({
          status: ProjectStatus.Active,
          podIp,
          lastActiveAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectEnvironments.id, projectId));

      return true;
    });
  }

  private async reconcilePendingPods(): Promise<void> {
    const pending = await db
      .select({
        id: projects.id,
        directory: projectEnvironments.directory,
        agentId: projects.agentId,
        podIp: projectEnvironments.podIp,
      })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(eq(projectEnvironments.status, ProjectStatus.Pending))
      .orderBy(asc(projects.createdAt));

    for (const row of pending) {
      const podName = this.podService.assignedPodName(row.id);
      const pod = await this.podService.getPod(podName).catch(() => null);
      if (!pod) {
        await this.enqueueRecycle(row.id, 'pod missing');
        continue;
      }
      if (pod.metadata?.deletionTimestamp) {
        await this.enqueueRecycle(row.id, 'pod terminating');
        continue;
      }
      if (this.podService.inspectFailureReason(pod) === 'ImagePullBackOff') {
        await this.enqueueRecycle(row.id, 'ImagePullBackOff');
        continue;
      }
      if (!this.podService.isPodReady(pod)) {
        if (this.podService.podAgeMs(pod) > STALE_PENDING_POD_MS) {
          await this.enqueueRecycle(row.id, 'pod not ready after grace period');
        }
        continue;
      }
      const agentName = this.agentIdToName.get(row.agentId);
      if (!agentName || !(await this.workspaceAtTarget(row.directory, agentName))) {
        await this.enqueueRecycle(row.id, 'agent template drift');
        continue;
      }
      const podIp = pod.status?.podIP ?? null;
      if (podIp && podIp !== row.podIp) {
        await db
          .update(projectEnvironments)
          .set({ podIp, updatedAt: new Date() })
          .where(and(eq(projectEnvironments.id, row.id), eq(projectEnvironments.status, ProjectStatus.Pending)));
      }
    }
  }

  private async readReadyPodIp(projectId: string): Promise<string | null> {
    const podName = this.podService.assignedPodName(projectId);
    const pod = await this.podService.getPod(podName).catch(() => null);
    if (!pod || pod.metadata?.deletionTimestamp || !this.podService.isPodReady(pod)) return null;
    return pod.status?.podIP ?? null;
  }

  private async countPoolSlots(agentId: string): Promise<number> {
    const [counts] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .innerJoin(projectEnvironments, eq(projectEnvironments.id, projects.id))
      .where(
        and(
          eq(projects.agentId, agentId),
          inArray(projectEnvironments.status, [ProjectStatus.Pending, ProjectStatus.Claiming])
        )
      );
    return counts?.count ?? 0;
  }

  private async sweepLegacyWarmPods(): Promise<void> {
    const legacy = await this.podService.listPods(POOL_LEGACY_WARM_SELECTOR).catch(() => []);
    if (legacy.length === 0) return;
    this.logger.log(`Sweeping ${legacy.length} legacy warm pod(s) from previous deploy`);
    await Promise.allSettled(
      legacy.map((pod) => {
        const name = pod.metadata?.name;
        if (!name) return Promise.resolve();
        return this.podService.deletePod(name);
      })
    );
  }

  private async cacheAgentIds(): Promise<void> {
    await this.agentReconciler.ready();
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        poolSize: agents.poolSize,
        version: agents.version,
        model: agents.model,
        variant: agents.variant,
      })
      .from(agents)
      .where(and(isNull(agents.tenantId), eq(agents.origin, 'built_in')));

    const targets = new Map<string, number>();
    const versions = new Map<string, string>();
    const models = new Map<string, AgentModelSelection>();
    for (const row of rows) {
      this.agentIdToName.set(row.id, row.name);
      this.agentNameToId.set(row.name, row.id);
      targets.set(row.name, row.poolSize);
      if (row.version) versions.set(row.name, row.version);
      if (row.model) {
        models.set(row.name, { model: row.model, ...(row.variant ? { variant: row.variant } : {}) });
      }
    }
    this.agentTargetByName = targets;
    this.agentVersionByName = versions;
    this.agentModelSelectionByName = models;
  }

  private effectiveTarget(agentName: string): number {
    const declared = this.agentTargetByName.get(agentName) ?? 0;
    const cap = this.poolSizeOverride;
    return cap !== null ? Math.min(declared, cap) : declared;
  }

  private async workspaceAtTarget(directory: string, agentName: string): Promise<boolean> {
    const targetVersion = this.agentVersionByName.get(agentName);
    const modelSelection = this.agentModelSelectionByName.get(agentName);
    if (!targetVersion && !modelSelection) return true;
    if (targetVersion) {
      const ledgerPath = join(this.storageMountPath, directory, '.opsiforce', 'agents', `${agentName}.json`);
      try {
        const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as { contentVersion?: string };
        if (ledger.contentVersion !== targetVersion) return false;
      } catch {
        return false;
      }
    }

    if (!modelSelection) return true;
    const configPath = join(this.storageMountPath, directory, '.opencode', 'opencode.json');
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        model?: string;
        agents?: Record<string, { model?: string } | undefined>;
      };
      const agentRef = config.agents?.[agentName]?.model ?? '';
      const [agentModel, agentVariant] = agentRef.split('#');
      if (config.model !== modelSelection.model || agentModel !== modelSelection.model) return false;
      if (modelSelection.variant && agentVariant !== modelSelection.variant) return false;
      return true;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
