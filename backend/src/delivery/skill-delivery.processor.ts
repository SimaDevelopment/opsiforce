import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { Job } from 'bullmq';
import { SKILL_DELIVERY_QUEUE, type SkillDeliveryJobData } from './delivery.types';
import { SkillDeliveryService } from './skill-delivery.service';

@Processor(SKILL_DELIVERY_QUEUE)
export class SkillDeliveryProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger(SkillDeliveryProcessor.name);

  constructor(private readonly deliveries: SkillDeliveryService) {
    super();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutdown signal ${signal ?? ''} received, draining worker...`);
    await this.worker.close();
  }

  async process(job: Job<SkillDeliveryJobData>): Promise<void> {
    try {
      const outcome = await this.deliveries.deliver(job.data);
      if (outcome.status !== 'converged') {
        this.logger.log(`Skill delivery to ${job.data.projectEnvironmentId} ${outcome.status}: ${outcome.reason}`);
      }
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(`Skill delivery to ${job.data.projectEnvironmentId} failed: ${failure.message}`);
      await this.deliveries.recordFailure(job.data, failure);
    }
  }
}
