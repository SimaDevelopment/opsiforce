import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { and, eq, not, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { db } from '../../db';
import { projectEnvironments, projects } from '../../db/schema';
import { ProjectStatus } from '../project/project.types';
import { TimeoutService } from './timeout.service';
import { PodService } from '../pod/pod.service';
import { ProjectEventsService } from '../project/project-events.service';
import { AppReadinessService } from '../project/app-readiness.service';
import { AgentStatusService } from '../project/agent-status.service';
import { servesAsServiceDefault } from '../external-services/publishing/service-default-environments';

@Injectable()
export class TimeoutListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimeoutListener.name);
  private subscriber!: Redis;
  private sweeping = false;

  constructor(
    private readonly timeoutService: TimeoutService,
    private readonly podService: PodService,
    private readonly projectEventsService: ProjectEventsService,
    private readonly appReadiness: AppReadinessService,
    private readonly agentStatusService: AgentStatusService
  ) {}

  async onModuleInit() {
    this.subscriber = new Redis(this.timeoutService.redisUrl);
    const channel = `__keyevent@${this.timeoutService.dbNumber}__:expired`;

    this.subscriber.on('message', (_channel, key) => {
      const parsed = this.timeoutService.parseExpiredKey(key);
      if (parsed) {
        this.handleKeyExpiry(parsed.envId, parsed.type).catch((err) => {
          this.logger.warn(`Failed to handle expiry for environment ${parsed.envId}: ${err.message}`);
        });
      }
    });

    this.subscriber.on('ready', () => {
      this.sweepExpiredEnvironments().catch((err) => {
        this.logger.warn(`Sweep failed: ${err.message}`);
      });
    });

    await this.subscriber.subscribe(channel);
    this.logger.log(`Subscribed to Redis keyspace notifications on ${channel}`);
  }

  async onModuleDestroy() {
    await this.subscriber?.quit();
  }

  private async handleKeyExpiry(envId: string, type: 'agent' | 'app'): Promise<void> {
    const fullyExpired = await this.timeoutService.isFullyExpired(envId);
    if (!fullyExpired) {
      this.logger.debug(`Environment ${envId} ${type} timeout expired, but other key still active — skipping`);
      return;
    }
    await this.suspendEnvironment(envId);
  }

  private async suspendEnvironment(envId: string): Promise<void> {
    const [updated] = await db
      .update(projectEnvironments)
      .set({
        status: ProjectStatus.Suspended,
        podIp: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectEnvironments.id, envId),
          eq(projectEnvironments.status, ProjectStatus.Active),
          sql`exists (select 1 from ${projects} where ${projects.id} = ${projectEnvironments.projectId} and ${projects.disabled} = false)`,
          not(servesAsServiceDefault())
        )
      )
      .returning({ projectId: projectEnvironments.projectId });

    if (!updated) {
      this.logger.debug(`Skipping suspend for environment ${envId}: status changed concurrently`);
      return;
    }

    const podName = this.podService.assignedPodName(envId);
    await this.podService.deletePod(podName).catch((err) => {
      this.logger.warn(`Failed to delete pod ${podName}: ${err.message}`);
    });

    this.appReadiness.markDown(envId);
    this.agentStatusService.clear(updated.projectId, envId);

    this.logger.log(`Environment ${envId} suspended due to idle timeout`);
    await this.projectEventsService.publish(updated.projectId);
  }

  private async sweepExpiredEnvironments(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      const activeEnvironments = await db
        .select({ id: projectEnvironments.id })
        .from(projectEnvironments)
        .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
        .where(and(eq(projectEnvironments.status, ProjectStatus.Active), eq(projects.disabled, false)));

      for (const env of activeEnvironments) {
        const expired = await this.timeoutService.isFullyExpired(env.id);
        if (expired) {
          await this.suspendEnvironment(env.id);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
