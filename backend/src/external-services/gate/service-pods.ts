import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import { PodService } from '../../pod/pod.service';
import type { PodRequestInit } from '../../pod/pod-fetch';
import { ProjectStatus } from '../../project/project.types';
import type { ServiceHome } from '../registry/custom-service-catalog';
import { ServicePodWaker } from './service-pod-waker';

export const SERVICE_POD_PORT = 'SERVICE_POD_PORT';

export const SERVICE_START_HOLD_MS = 'SERVICE_START_HOLD_MS';

export const SERVICE_START_HOLD = 60_000;

export const SERVICE_STARTING_RETRY_AFTER_SECONDS = 5;

const STALE_READINESS_RECHECK_MS = 250;

export interface ServicePod {
  url: string;
  projectEnvironmentId: string;
}

export type UnreachablePodCode = 'service-starting' | 'service-disabled' | 'service-failed';

export class UnreachablePod extends Error {
  constructor(
    readonly code: UnreachablePodCode,
    detail: string
  ) {
    super(detail);
  }
}

@Injectable()
export class ServicePods {
  private readonly pods = new Map<string, ServicePod>();

  constructor(
    @Inject(SERVICE_POD_PORT) private readonly podPort: number,
    @Inject(SERVICE_START_HOLD_MS) private readonly startHoldMs: number,
    private readonly waker: ServicePodWaker,
    private readonly podService: PodService
  ) {}

  serve(serviceId: string, pod: ServicePod): () => void {
    this.pods.set(serviceId, pod);
    return () => {
      if (this.pods.get(serviceId) === pod) this.pods.delete(serviceId);
    };
  }

  podOf(serviceId: string): ServicePod | undefined {
    return this.pods.get(serviceId);
  }

  async reach(home: ServiceHome): Promise<ServicePod> {
    if (home.disabled) throw new UnreachablePod('service-disabled', 'The service is disabled.');
    const { projectEnvironmentId } = home;
    const state = await this.waker.wake(projectEnvironmentId);
    if (state === 'disabled') throw new UnreachablePod('service-disabled', 'The service is disabled.');
    if (state === 'failed') throw new UnreachablePod('service-failed', "The service couldn't start.");
    if (state === 'starting' && !(await this.awaitActive(projectEnvironmentId))) {
      throw new UnreachablePod('service-starting', 'The service is starting; retry shortly.');
    }
    return { url: this.podService.podAddress(projectEnvironmentId, this.podPort), projectEnvironmentId };
  }

  podFetch(pod: ServicePod, path: string, init?: PodRequestInit): Promise<Response> {
    return this.podService.podFetch(pod.projectEnvironmentId, this.podPort, path, init);
  }

  private async awaitActive(projectEnvironmentId: string): Promise<boolean> {
    const deadline = Date.now() + this.startHoldMs;
    for (let remaining = this.startHoldMs; remaining > 0; remaining = deadline - Date.now()) {
      if (!(await this.waker.awaitServing(projectEnvironmentId, remaining))) return false;
      const status = await statusOf(projectEnvironmentId);
      if (status === ProjectStatus.Active) return true;
      if (status === ProjectStatus.Failed) {
        throw new UnreachablePod('service-failed', "The service couldn't start.");
      }
      await sleep(Math.min(STALE_READINESS_RECHECK_MS, Math.max(deadline - Date.now(), 0)));
    }
    return false;
  }
}

async function statusOf(projectEnvironmentId: string) {
  const [environment] = await db
    .select({ status: projectEnvironments.status })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.id, projectEnvironmentId));
  return environment?.status;
}
