import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceProjectConfigs } from '../../../db/schema';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import {
  doorbellFollowUpJobId,
  doorbellJobId,
  EXTERNAL_SERVICE_DOORBELL_QUEUE,
  RING_JOB,
  type DoorbellJobData,
} from './doorbell.types';

@Injectable()
export class Doorbell {
  constructor(
    @InjectQueue(EXTERNAL_SERVICE_DOORBELL_QUEUE) private readonly queue: Queue<DoorbellJobData>,
    private readonly services: ServiceRegistry
  ) {}

  async ringFor(service: RegisteredService, stored: readonly { projectEnvironmentId: string }[]): Promise<void> {
    for (const { projectEnvironmentId } of stored) {
      await this.enqueue(projectEnvironmentId, service);
    }
  }

  async appStarted(projectEnvironmentId: string): Promise<void> {
    await db
      .update(externalServiceProjectConfigs)
      .set({ unwiredSince: null })
      .where(
        and(
          eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironmentId),
          isNotNull(externalServiceProjectConfigs.unwiredSince)
        )
      );
    const configured = await db
      .select({ externalServiceId: externalServiceProjectConfigs.externalServiceId })
      .from(externalServiceProjectConfigs)
      .where(eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironmentId));
    for (const { externalServiceId } of configured) {
      const service = await servableOrNone(this.services.byIdForEnvironment(projectEnvironmentId, externalServiceId));
      if (service) await this.enqueue(projectEnvironmentId, service, { promoteWaitingRetry: true });
    }
  }

  async isUnwired(projectEnvironmentId: string, externalServiceId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: externalServiceProjectConfigs.id })
      .from(externalServiceProjectConfigs)
      .where(
        and(
          this.projectConfigurationOf(projectEnvironmentId, externalServiceId),
          isNotNull(externalServiceProjectConfigs.unwiredSince)
        )
      );
    return row !== undefined;
  }

  async markUnwired(projectEnvironmentId: string, externalServiceId: string): Promise<void> {
    await db
      .update(externalServiceProjectConfigs)
      .set({ unwiredSince: new Date() })
      .where(
        and(
          this.projectConfigurationOf(projectEnvironmentId, externalServiceId),
          isNull(externalServiceProjectConfigs.unwiredSince)
        )
      );
  }

  private projectConfigurationOf(projectEnvironmentId: string, externalServiceId: string) {
    return and(
      eq(externalServiceProjectConfigs.projectEnvironmentId, projectEnvironmentId),
      eq(externalServiceProjectConfigs.externalServiceId, externalServiceId)
    );
  }

  private async enqueue(
    projectEnvironmentId: string,
    service: RegisteredService,
    { promoteWaitingRetry = false } = {}
  ): Promise<void> {
    const jobId = doorbellJobId(projectEnvironmentId, service.id);
    const ringing = await this.queue.getJob(jobId);
    if (promoteWaitingRetry && ringing && (await ringing.isDelayed())) {
      await ringing.updateData({ ...ringing.data, retry: 0 });
      await ringing.promote().catch(async (error: unknown) => {
        if (await ringing.isDelayed()) throw error;
      });
      return;
    }
    await this.queue.add(
      RING_JOB,
      { projectEnvironmentId, externalServiceId: service.id, service: service.slug, retry: 0 },
      {
        jobId: ringing && (await ringing.isActive()) ? doorbellFollowUpJobId(jobId) : jobId,
        removeOnComplete: true,
        removeOnFail: true,
      }
    );
  }
}
