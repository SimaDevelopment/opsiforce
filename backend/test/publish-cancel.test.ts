import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db';
import { projectPublishJobs } from '../db/schema';
import { EnvironmentService } from '../src/environment/environment.service';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { PublicUrlService } from '../src/project-environment/public-url.service';
import { ProjectEventsService } from '../src/project/project-events.service';
import { ProjectService } from '../src/project/project.service';
import { ProjectStatus } from '../src/project/project.types';
import { PublishCancellations, PublishCancelledError, unlessCancelled } from '../src/publish/publish-cancellations';
import { PublishService } from '../src/publish/publish.service';
import { PublishStatus } from '../src/publish/publish.types';
import { ProjectTurns } from '../src/publish/project-turns';
import { FakeQueue } from './support/infra-fakes';
import { createProject, createTenant, type TenantFixture } from './support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './public-api/support/app';

async function moveJobTo(jobId: string, status: PublishStatus) {
  await db.update(projectPublishJobs).set({ status }).where(eq(projectPublishJobs.id, jobId));
}

describe('Cancelling a publish', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let cancellations: PublishCancellations;
  let publisher: PublishService;
  let tenant: TenantFixture;
  let production: string;

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
    cancellations = new PublishCancellations();
    publisher = new PublishService(
      app.get(ConfigService),
      app.get(EnvironmentService),
      app.get(ProjectEnvironmentService),
      app.get(PublicUrlService),
      app.get(ProjectService),
      { choices: async () => [] } as never,
      app.get(ProjectEventsService),
      cancellations,
      new FakeQueue() as never
    );
    tenant = await createTenant(app);
    production = (
      await app
        .get(EnvironmentService)
        .create(tenant.tenantId, { name: 'Live', slug: `live-${randomUUID().slice(0, 6)}` })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('lets the next publish start once a queued one is cancelled', async () => {
    const projectId = await createProject(app, tenant);
    const queued = await publisher.publish(projectId, tenant.tenantId, { environmentId: production });

    const cancelled = await publisher.cancel(projectId, production);

    expect(cancelled).toMatchObject({ status: PublishStatus.Failed, error: 'Publish cancelled.' });
    expect((await app.get(ProjectEnvironmentService).findById(queued.projectEnvironmentId)).status).toBe(
      ProjectStatus.Failed
    );
    await expect(publisher.publish(projectId, tenant.tenantId, { environmentId: production })).resolves.toMatchObject({
      status: PublishStatus.Queued,
    });
  });

  it('stops a publish that is waiting for its app', async () => {
    const projectId = await createProject(app, tenant);
    const job = await publisher.publish(projectId, tenant.tenantId, { environmentId: production });
    await moveJobTo(job.id, PublishStatus.Migrating);
    const outcome = unlessCancelled(cancellations.begin(job.id), new Promise<boolean>(() => undefined)).catch(
      (err: unknown) => err
    );

    await publisher.cancel(projectId, production);

    expect(await outcome).toBeInstanceOf(PublishCancelledError);
    cancellations.end(job.id);
  });

  it('refuses while a publish copies files', async () => {
    const projectId = await createProject(app, tenant);
    const job = await publisher.publish(projectId, tenant.tenantId, { environmentId: production });
    await moveJobTo(job.id, PublishStatus.Swapping);

    await expect(publisher.cancel(projectId, production)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses when no publish is in progress', async () => {
    const projectId = await createProject(app, tenant);

    await expect(publisher.cancel(projectId, production)).rejects.toMatchObject({ status: 409 });
  });
});

describe('Publishes of different Projects', () => {
  it("run side by side while one Project's publishes take turns", async () => {
    const turns = new ProjectTurns();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = turns.run('project-a', async () => {
      order.push('a1 start');
      await firstHolds;
      order.push('a1 end');
    });
    const second = turns.run('project-a', async () => {
      order.push('a2 start');
    });
    await turns.run('project-b', async () => {
      order.push('b1 start');
    });
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['a1 start', 'b1 start', 'a1 end', 'a2 start']);
  });
});
