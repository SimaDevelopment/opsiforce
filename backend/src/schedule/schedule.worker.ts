import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { projects } from '../../db/schema';
import { ScheduleService } from './schedule.service';
import { ProjectService } from '../project/project.service';
import { AppReadinessService } from '../project/app-readiness.service';
import { ProxyService } from '../proxy/proxy.service';
import type { PodRequestInit } from '../pod/pod-fetch';
import { SCHEDULE_QUEUE_NAME, type ScheduleJobData, type ScheduleTrigger } from './schedule.types';

@Processor(SCHEDULE_QUEUE_NAME)
export class ScheduleWorker extends WorkerHost {
  private readonly logger = new Logger(ScheduleWorker.name);

  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly projectService: ProjectService,
    private readonly appReadiness: AppReadinessService,
    private readonly proxyService: ProxyService
  ) {
    super();
  }

  async process(job: Job<ScheduleJobData>): Promise<void> {
    const { scheduleId } = job.data;
    const isManual = job.name === 'manual';

    const trigger: ScheduleTrigger = isManual ? 'manual' : 'cron';

    const schedule = await this.scheduleService.findOneRaw(scheduleId);
    if (!schedule) {
      this.logger.warn(`Schedule ${scheduleId} not found, skipping`);
      return;
    }

    if (!isManual && !schedule.isActive) {
      return;
    }

    const routingId = schedule.projectEnvironmentId ?? schedule.projectId;

    const [project] = await db.select().from(projects).where(eq(projects.id, schedule.projectId));

    if (!project) {
      await this.scheduleService.recordExecution(scheduleId, trigger, null, null, 'project not found');
      return;
    }

    const ensured = await this.projectService.ensureEnvironmentById(routingId, 'app');

    if (ensured.state === 'disabled' || ensured.state === 'failed') {
      await this.scheduleService.recordExecution(
        scheduleId,
        trigger,
        null,
        null,
        ensured.state === 'failed' ? 'project failed' : 'project disabled'
      );
      return;
    }

    if (ensured.state === 'starting') {
      const ready = await this.appReadiness.awaitReady(routingId, 120_000);
      if (!ready) {
        await this.scheduleService.recordExecution(scheduleId, trigger, null, null, 'pod startup timeout');
        return;
      }
    }
    const start = Date.now();

    try {
      const extraHeaders =
        schedule.headers && typeof schedule.headers === 'object' ? (schedule.headers as Record<string, string>) : {};

      const hasBody = schedule.body != null && schedule.method !== 'GET';

      const fetchOptions: PodRequestInit = {
        method: schedule.method,
        headers: {
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        ...(hasBody ? { body: JSON.stringify(schedule.body) } : {}),
      };

      const response = await this.proxyService.fetchApp(routingId, schedule.targetPath, fetchOptions);
      const latencyMs = Date.now() - start;
      await this.scheduleService.recordExecution(scheduleId, trigger, response.status, latencyMs);

      this.logger.log(`Schedule "${schedule.name}" fired: ${response.status} in ${latencyMs}ms`);
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.scheduleService.recordExecution(scheduleId, trigger, null, latencyMs, errorMessage);
      this.logger.error(`Schedule "${schedule.name}" failed: ${errorMessage}`);
    }
  }
}
