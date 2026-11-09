import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvironmentService } from '../src/environment/environment.service';
import { ProjectEnvironmentService } from '../src/project-environment/project-environment.service';
import { PublicUrlService } from '../src/project-environment/public-url.service';
import { ProjectService } from '../src/project/project.service';
import { ProjectStatus } from '../src/project/project.types';
import { PublishService } from '../src/publish/publish.service';
import { PublishCancellations } from '../src/publish/publish-cancellations';
import { ProjectEventsService } from '../src/project/project-events.service';
import { FakeQueue } from './support/infra-fakes';
import { createProject, createTenant, type TenantFixture } from './support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from './public-api/support/app';

describe('Publish with data refusals', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let publisher: PublishService;
  let tenant: TenantFixture;
  let production: string;

  beforeAll(async () => {
    harness = await createPublicApiTestApp();
    app = harness.app;
    publisher = new PublishService(
      app.get(ConfigService),
      app.get(EnvironmentService),
      app.get(ProjectEnvironmentService),
      app.get(PublicUrlService),
      app.get(ProjectService),
      { choices: async () => [] } as never,
      app.get(ProjectEventsService),
      new PublishCancellations(),
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

  async function developmentOf(projectId: string) {
    return app.get(ProjectEnvironmentService).findDefaultByProjectId(projectId);
  }

  async function giveDevelopmentData(projectId: string) {
    const development = await developmentOf(projectId);
    const file = path.join(
      app.get(ConfigService).getOrThrow<string>('storageMountPath'),
      development.directory,
      'app',
      'data',
      'app.db'
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'rows');
  }

  it('offers the toggle only once Development holds App data', async () => {
    const projectId = await createProject(app, tenant);

    expect((await publisher.getForm(projectId, tenant.tenantId, production)).developmentHasData).toBe(false);
    await giveDevelopmentData(projectId);
    expect((await publisher.getForm(projectId, tenant.tenantId, production)).developmentHasData).toBe(true);
  });

  it('refuses to publish with data when Development has none', async () => {
    const projectId = await createProject(app, tenant);

    await expect(
      publisher.publish(projectId, tenant.tenantId, { environmentId: production, withData: true })
    ).rejects.toMatchObject({ response: { code: 'no-development-data' } });
  });

  it('refuses to publish with data while Development is starting', async () => {
    const projectId = await createProject(app, tenant);
    await giveDevelopmentData(projectId);
    const development = await developmentOf(projectId);
    await app.get(ProjectEnvironmentService).patch(development.id, { status: ProjectStatus.Starting });

    await expect(
      publisher.publish(projectId, tenant.tenantId, { environmentId: production, withData: true })
    ).rejects.toMatchObject({ response: { code: 'development-busy' } });
  });
});
