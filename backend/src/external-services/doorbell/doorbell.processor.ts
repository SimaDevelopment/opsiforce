import path from 'node:path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments, projects } from '../../../db/schema';
import { AppReadinessService } from '../../project/app-readiness.service';
import { ProjectService } from '../../project/project.service';
import { ProxyService } from '../../proxy/proxy.service';
import { ExternalServiceStore } from '../inbound/external-service-store';
import { servableOrNone } from '../registry/custom-service-catalog';
import { ServiceRegistry, type RegisteredService } from '../registry/service-registry';
import { Doorbell } from './doorbell';
import {
  DOORBELL_RETRY_DELAYS_MS,
  EXTERNAL_SERVICE_DOORBELL_QUEUE,
  MAX_EVENT_IDS_PER_RING,
  type DoorbellJobData,
} from './doorbell.types';

const APP_WAKE_TIMEOUT_MS = 120_000;
const APP_ANSWER_TIMEOUT_MS = 10_000;
const CONCURRENT_RINGS = 20;

type RingOutcome = 'delivered' | 'not-wired' | 'retry' | 'stop';

interface Ring {
  outcome: RingOutcome;
  status: number;
  code: string | null;
  detail: string;
  outputBytes?: number;
}

interface ReceivingEnvironment {
  directory: string;
  projectId: string;
  projectTitle: string | null;
  tenantId: string | null;
}

function duration(ms: number): string {
  if (ms >= 3_600_000) return `${ms / 3_600_000} h`;
  if (ms >= 60_000) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function deliveredDetail(eventCount: number, rowCount: number): string {
  const rows = rowCount > 0 ? ` and ${counted(rowCount, 'message row id')}` : '';
  return `Delivered ${counted(eventCount, 'Event id')}${rows}.`;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

@Processor(EXTERNAL_SERVICE_DOORBELL_QUEUE, { concurrency: CONCURRENT_RINGS })
export class DoorbellProcessor extends WorkerHost {
  private readonly logger = new Logger(DoorbellProcessor.name);
  private readonly storageMountPath: string;

  constructor(
    private readonly services: ServiceRegistry,
    private readonly doorbell: Doorbell,
    private readonly store: ExternalServiceStore,
    private readonly projectService: ProjectService,
    private readonly appReadiness: AppReadinessService,
    private readonly proxy: ProxyService,
    config: ConfigService
  ) {
    super();
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async process(job: Job<DoorbellJobData>, token?: string): Promise<void> {
    const { projectEnvironmentId, externalServiceId, retry } = job.data;
    const service = await this.receivedService(projectEnvironmentId, externalServiceId);
    if (!service) return;
    if (await this.doorbell.isUnwired(projectEnvironmentId, externalServiceId)) return;
    const environment = await this.receivingEnvironment(projectEnvironmentId);
    if (!environment) return;

    const envDirectory = path.join(this.storageMountPath, environment.directory);
    const eventIds = await this.store.undeliveredEventIds(envDirectory, service.slug, MAX_EVENT_IDS_PER_RING);
    const rowIds = await this.store.undeliveredLegacyRowIds(envDirectory, service.slug, MAX_EVENT_IDS_PER_RING);
    if (eventIds.length === 0 && (rowIds ?? []).length === 0) return;

    const body = JSON.stringify(
      rowIds === null ? { service: service.slug, eventIds } : { service: service.slug, rowIds, eventIds }
    );
    const ring = await this.ring(projectEnvironmentId, service, body, eventIds.length, rowIds?.length ?? 0);
    if (ring.outcome === 'retry') ring.detail += this.retryNote(retry);

    if (ring.outcome !== 'delivered') {
      this.logger.log(
        `Doorbell for "${service.slug}" in environment ${projectEnvironmentId}: ${ring.outcome} (${ring.code ?? ring.status}) ${ring.detail}`
      );
    }

    if (ring.outcome === 'delivered') {
      await this.store.markEventsDelivered(envDirectory, eventIds);
      if (rowIds !== null) await this.store.markDelivered(envDirectory, rowIds);
      const more = [
        ...(await this.store.undeliveredEventIds(envDirectory, service.slug, 1)),
        ...((await this.store.undeliveredLegacyRowIds(envDirectory, service.slug, 1)) ?? []),
      ];
      if (more.length > 0) await this.ringAgain(job, token, 0, 0);
      return;
    }
    if (ring.outcome === 'not-wired') {
      await this.doorbell.markUnwired(projectEnvironmentId, externalServiceId);
      return;
    }
    if (ring.outcome === 'retry') {
      const delay = DOORBELL_RETRY_DELAYS_MS[retry];
      if (delay === undefined) {
        this.logger.warn(
          `Doorbell for "${service.slug}" in environment ${projectEnvironmentId} gave up after ${retry + 1} rings`
        );
        return;
      }
      await this.ringAgain(job, token, delay, retry + 1);
    }
  }

  private async receivedService(
    projectEnvironmentId: string,
    externalServiceId: string
  ): Promise<RegisteredService | null | undefined> {
    return servableOrNone(this.services.byIdForEnvironment(projectEnvironmentId, externalServiceId), (error) =>
      this.logger.warn(`Doorbell for ${externalServiceId} skipped: its files cannot be served (${error.message})`)
    );
  }

  private async ringAgain(
    job: Job<DoorbellJobData>,
    token: string | undefined,
    delay: number,
    retry: number
  ): Promise<never> {
    await job.updateData({ ...job.data, retry });
    await job.moveToDelayed(Date.now() + delay, token);
    throw new DelayedError();
  }

  private retryNote(retry: number): string {
    const delay = DOORBELL_RETRY_DELAYS_MS[retry];
    return delay === undefined ? ` Gave up after ${retry + 1} rings.` : ` Ringing again in ${duration(delay)}.`;
  }

  private async ring(
    projectEnvironmentId: string,
    service: RegisteredService,
    body: string,
    eventCount: number,
    rowCount: number
  ): Promise<Ring> {
    const woken = await this.wake(projectEnvironmentId);
    if (woken) return woken;

    let response: Response;
    try {
      const upstream = await this.proxy.resolveAppUpstreamByEnvironmentId(projectEnvironmentId);
      response = await fetch(`${upstream}/api/external-services/${service.slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(APP_ANSWER_TIMEOUT_MS),
      });
    } catch (error) {
      if (isTimeout(error)) {
        return {
          outcome: 'retry',
          status: 504,
          code: 'timeout',
          detail: `The App did not answer within ${duration(APP_ANSWER_TIMEOUT_MS)}.`,
        };
      }
      return {
        outcome: 'retry',
        status: 502,
        code: 'app-unreachable',
        detail: `The App could not be reached: ${(error as Error).message}.`,
      };
    }

    const outputBytes = (await response.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
    if (response.ok) {
      return {
        outcome: 'delivered',
        status: response.status,
        code: null,
        detail: deliveredDetail(eventCount, rowCount),
        outputBytes,
      };
    }
    if (response.status === 404 || response.status === 501) {
      return {
        outcome: 'not-wired',
        status: response.status,
        code: 'not-wired',
        detail: `The App answered ${response.status}: not wired for "${service.slug}" until it starts again.`,
        outputBytes,
      };
    }
    if (response.status < 500) {
      return {
        outcome: 'stop',
        status: response.status,
        code: 'app-refused',
        detail: `The App answered ${response.status}; the doorbell rings again with the next Event.`,
        outputBytes,
      };
    }
    return {
      outcome: 'retry',
      status: response.status,
      code: 'app-failed',
      detail: `The App answered ${response.status}.`,
      outputBytes,
    };
  }

  private async wake(projectEnvironmentId: string): Promise<Ring | null> {
    let state: string;
    try {
      state = (await this.projectService.ensureEnvironmentById(projectEnvironmentId, 'app')).state;
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      return { outcome: 'stop', status: 404, code: 'app-gone', detail: 'The environment no longer exists.' };
    }
    if (state === 'disabled') {
      return { outcome: 'stop', status: 503, code: 'app-disabled', detail: 'The Project is disabled.' };
    }
    if (state === 'failed') {
      return { outcome: 'retry', status: 503, code: 'app-not-ready', detail: 'The App failed to start.' };
    }
    if (state === 'starting' && !(await this.appReadiness.awaitReady(projectEnvironmentId, APP_WAKE_TIMEOUT_MS))) {
      return {
        outcome: 'retry',
        status: 503,
        code: 'app-not-ready',
        detail: `The App did not start within ${duration(APP_WAKE_TIMEOUT_MS)}.`,
      };
    }
    return null;
  }

  private async receivingEnvironment(projectEnvironmentId: string): Promise<ReceivingEnvironment | null> {
    const [row] = await db
      .select({
        directory: projectEnvironments.directory,
        projectId: projectEnvironments.projectId,
        projectTitle: projects.title,
        tenantId: projects.tenantId,
      })
      .from(projectEnvironments)
      .innerJoin(projects, eq(projects.id, projectEnvironments.projectId))
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    return row ?? null;
  }
}
