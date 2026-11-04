import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServices, projectApps } from '../../db/schema';
import { AppService } from '../../src/project/app.service';
import { createPublicApiTestApp, type PublicApiTestApp } from './support/app';
import {
  addMember,
  addNamedEnvironment,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';

const APPS = 'apps.public-api.test';

let harness: PublicApiTestApp;
let app: NestFastifyApplication;
let tenant: TenantFixture;
let member: MemberFixture;

beforeAll(async () => {
  harness = await createPublicApiTestApp({ APPS_HOSTNAME: APPS });
  app = harness.app;
  tenant = await createTenant(app);
  member = await addMember(app, tenant);
});

afterAll(async () => {
  await harness.close();
});

function shortIdOf(environmentId: string): string {
  return environmentId.replaceAll('-', '').slice(0, 12);
}

async function goLive(projectId: string, environmentId: string, name: string): Promise<void> {
  await app.get(AppService).upsertProjectApp(environmentId, projectId, { name, description: null });
}

async function appLeftOnItsLegacyHost(projectId: string, environmentId: string): Promise<void> {
  await db.insert(projectApps).values({ projectEnvironmentId: environmentId, projectId, name: 'Equipment Monitor' });
}

async function serveAnExternalService(projectId: string): Promise<void> {
  const id = randomUUID();
  await db.insert(externalServices).values({
    id,
    tenantId: tenant.tenantId,
    origin: 'custom',
    slug: `service-${id.slice(0, 8)}`,
    builderChatId: projectId,
  });
}

async function publicUrlsOf(projectId: string): Promise<Record<string, string | null>> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${projectId}`, headers: member.headers });
  expect(res.statusCode, res.body).toBe(200);
  const environments: { id: string; publicUrl: string | null }[] = res.json().environments;
  return Object.fromEntries(environments.map((environment) => [environment.id, environment.publicUrl]));
}

describe('an environment of a Project read through the Public API', () => {
  it('carries the readable Public URL once its App is live', async () => {
    const projectId = await createProject(app, tenant);

    await goLive(projectId, projectId, 'Equipment Monitor');

    expect((await publicUrlsOf(projectId))[projectId]).toBe(
      `https://equipment-monitor-dev-${shortIdOf(projectId)}.${APPS}/`
    );
  });

  it('carries the legacy Public URL of an App left on its legacy host', async () => {
    const projectId = await createProject(app, tenant);

    await appLeftOnItsLegacyHost(projectId, projectId);

    expect((await publicUrlsOf(projectId))[projectId]).toBe(`https://${projectId}-dev.${APPS}/`);
  });

  it('carries null before the App first goes live', async () => {
    const projectId = await createProject(app, tenant);
    const staging = await addNamedEnvironment(app, tenant, projectId, 'Staging');

    expect(await publicUrlsOf(projectId)).toEqual({ [projectId]: null, [staging]: null });
  });

  it('carries null for a Project that serves an External Service, even with a live App', async () => {
    const projectId = await createProject(app, tenant);
    await serveAnExternalService(projectId);

    await goLive(projectId, projectId, 'Boards');

    expect((await publicUrlsOf(projectId))[projectId]).toBeNull();
  });
});
