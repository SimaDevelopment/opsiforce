import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import { DoorbellProcessor } from '../../../src/external-services/doorbell/doorbell.processor';
import { EXTERNAL_SERVICE_DOORBELL_QUEUE } from '../../../src/external-services/doorbell/doorbell.types';
import { PodService } from '../../../src/pod/pod.service';
import { ProjectStatus } from '../../../src/project/project.types';
import { TimeoutService } from '../../../src/timeout/timeout.service';
import type { FakeCoalescingQueue, FakePodService, FakeTimeoutService } from '../../support/infra-fakes';
import { waitFor } from '../../support/wait-for';
import type { GateCallerFixture } from './gate';

export const FAKE_APP_HOST = '127.0.0.1';

export function doorbellQueue(app: INestApplication): FakeCoalescingQueue {
  return app.get<FakeCoalescingQueue>(getQueueToken(EXTERNAL_SERVICE_DOORBELL_QUEUE));
}

export function ringDoorbells(app: INestApplication, until?: number): Promise<void> {
  const processor = app.get(DoorbellProcessor);
  return doorbellQueue(app).drain((job, token) => processor.process(job as unknown as Job, token), until);
}

export function fakePods(app: INestApplication): FakePodService {
  return app.get(PodService) as unknown as FakePodService;
}

export function appActivity(app: INestApplication, projectEnvironmentId: string): number {
  const timeouts = app.get(TimeoutService) as unknown as FakeTimeoutService;
  return timeouts.callsTo('touchApp').filter((call) => call.args.environmentId === projectEnvironmentId).length;
}

export async function environmentStatus(projectEnvironmentId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: projectEnvironments.status })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.id, projectEnvironmentId));
  return row?.status;
}

export function podStarts(app: INestApplication, projectEnvironmentId: string): number {
  const pods = fakePods(app);
  const podName = pods.assignedPodName(projectEnvironmentId);
  return pods.callsTo('waitForReady').filter((call) => call.args.podName === podName).length;
}

export async function podComesUp(app: INestApplication, projectEnvironmentId: string, startsBefore = 0): Promise<void> {
  await waitFor(() => podStarts(app, projectEnvironmentId) > startsBefore);
  const pods = fakePods(app);
  pods.markPodReady(pods.assignedPodName(projectEnvironmentId), FAKE_APP_HOST);
  await waitFor(async () => (await environmentStatus(projectEnvironmentId)) === ProjectStatus.Active);
}

export async function suspend(app: INestApplication, projectEnvironmentId: string): Promise<void> {
  const pods = fakePods(app);
  await pods.deletePod(pods.assignedPodName(projectEnvironmentId));
  await db
    .update(projectEnvironments)
    .set({ status: ProjectStatus.Suspended, podIp: null })
    .where(eq(projectEnvironments.id, projectEnvironmentId));
}

export function reportAppServing(app: NestFastifyApplication, environment: GateCallerFixture) {
  return app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${environment.key}` },
    payload: { serving: true },
  });
}
