import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectApps, projectEnvironments } from '../../db/schema';
import { AppSlugBackfill } from '../../src/project/app-slug-backfill';
import { ProjectController } from '../../src/project/project.controller';
import { ProjectService } from '../../src/project/project.service';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import { createCustomService, ensureExternalServiceBuilder } from '../support/custom-services';
import { tenantAdmin } from '../support/external-service-fixtures';
import {
  addMember,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';

const APPS = 'apps.existing.test';

@Module({ controllers: [ProjectController] })
class EditUrlRoutes {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;

beforeAll(async () => {
  await ensureExternalServiceBuilder();
  harness = await createExternalServicesTestApp({ env: { APPS_HOSTNAME: APPS }, extraModules: [EditUrlRoutes] });
  app = harness.app;
});

afterAll(async () => {
  await harness.close();
});

interface ExistingApp {
  tenant: TenantFixture;
  owner: MemberFixture;
  projectId: string;
}

async function appFromBeforeAppSlugs(name: string | null): Promise<ExistingApp> {
  const tenant = await createTenant(app);
  const owner = await addMember(app, tenant, ['can_edit_app_details']);
  const projectId = await createProject(app, tenant);
  await db.insert(projectApps).values({ projectEnvironmentId: projectId, projectId, name });
  return { tenant, owner, projectId };
}

async function listed(tenantId: string, projectId: string) {
  const environments = await app.get(ProjectService).listEnvironments(projectId, tenantId);
  return environments.find((entry) => entry.id === projectId);
}

function switchTo(existing: ExistingApp, appSlug: string | null | undefined) {
  return app.inject({
    method: 'PATCH',
    url: `/api/projects/${existing.projectId}/app`,
    headers: existing.owner.headers,
    payload: { environmentId: existing.projectId, appSlug },
  });
}

function shortIdOf(environmentId: string): string {
  return environmentId.replaceAll('-', '').slice(0, 12);
}

async function appSlugOf(projectEnvironmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: projectApps.slug })
    .from(projectApps)
    .where(eq(projectApps.projectEnvironmentId, projectEnvironmentId));
  return row.slug;
}

async function withManualAppAuth(existing: ExistingApp): Promise<ExistingApp> {
  await db
    .update(projectEnvironments)
    .set({ authMode: 'manual' })
    .where(eq(projectEnvironments.id, existing.projectId));
  return existing;
}

describe('the start-up pass over Apps without an App Slug', () => {
  it('gives an App its App Slug from its name, so it hands out the readable address', async () => {
    const warehouse = await appFromBeforeAppSlugs('Warehouse');

    expect(await new AppSlugBackfill().run()).toContain(warehouse.projectId);

    expect(await listed(warehouse.tenant.tenantId, warehouse.projectId)).toMatchObject({
      appSlug: 'warehouse',
      publicUrl: `https://warehouse-dev-${shortIdOf(warehouse.projectId)}.${APPS}/`,
      suggestedAppSlug: null,
    });
  });

  it.each([
    ['an empty', null, 'app'],
    ['an untransliterable', '中文名', 'app'],
    ['a Cyrillic', 'Облік обладнання', 'oblik-obladnannya'],
  ])('gives an App with %s name a readable App Slug', async (_case, name, appSlug) => {
    const existing = await appFromBeforeAppSlugs(name);

    await new AppSlugBackfill().run();

    expect(await appSlugOf(existing.projectId)).toBe(appSlug);
  });

  it('leaves an App whose sign-in callbacks are registered outside on its legacy host, offered a readable address', async () => {
    const manual = await withManualAppAuth(await appFromBeforeAppSlugs('Warehouse'));

    expect(await new AppSlugBackfill().run()).not.toContain(manual.projectId);

    expect(await listed(manual.tenant.tenantId, manual.projectId)).toMatchObject({
      appSlug: null,
      publicUrl: `https://${manual.projectId}-dev.${APPS}/`,
      suggestedAppSlug: 'warehouse',
    });
  });

  it('leaves a Project that serves an External Service without an App Slug', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Boards', 'boards');
    const builderChatId = service.builderChatId;
    await db
      .insert(projectApps)
      .values({ projectEnvironmentId: builderChatId, projectId: builderChatId, name: 'Boards' });

    expect(await new AppSlugBackfill().run()).not.toContain(builderChatId);

    expect(await appSlugOf(builderChatId)).toBeNull();
  });

  it('never overwrites an App Slug an App already has', async () => {
    const edited = await appFromBeforeAppSlugs('Warehouse');
    await db.update(projectApps).set({ slug: 'stock' }).where(eq(projectApps.projectEnvironmentId, edited.projectId));

    expect(await new AppSlugBackfill().run()).not.toContain(edited.projectId);

    expect(await appSlugOf(edited.projectId)).toBe('stock');
  });

  it('changes nothing when it runs again', async () => {
    const warehouse = await appFromBeforeAppSlugs('Warehouse');
    await new AppSlugBackfill().run();

    expect(await new AppSlugBackfill().run()).not.toContain(warehouse.projectId);

    expect(await appSlugOf(warehouse.projectId)).toBe('warehouse');
  });

  it('gives each App its App Slug once when two replicas run it at the same time', async () => {
    const warehouse = await appFromBeforeAppSlugs('Warehouse');

    const runs = await Promise.all([new AppSlugBackfill().run(), new AppSlugBackfill().run()]);

    expect(runs.flat().filter((id) => id === warehouse.projectId)).toHaveLength(1);
    expect(await appSlugOf(warehouse.projectId)).toBe('warehouse');
  });
});

describe('an App left on its legacy host', () => {
  it('moves to the readable address once its owner switches to the suggestion through Edit URL', async () => {
    const manual = await withManualAppAuth(await appFromBeforeAppSlugs('Warehouse'));
    const offered = await listed(manual.tenant.tenantId, manual.projectId);

    const switched = await switchTo(manual, offered?.suggestedAppSlug);

    expect(switched.statusCode, switched.body).toBe(200);
    expect(await listed(manual.tenant.tenantId, manual.projectId)).toMatchObject({
      appSlug: 'warehouse',
      publicUrl: `https://warehouse-dev-${shortIdOf(manual.projectId)}.${APPS}/`,
      suggestedAppSlug: null,
    });
  });

  it.each([
    ['an empty', null, 'app'],
    ['a Cyrillic', 'Облік обладнання', 'oblik-obladnannya'],
  ])('is offered a readable App Slug for %s name', async (_case, name, suggestedAppSlug) => {
    const manual = await withManualAppAuth(await appFromBeforeAppSlugs(name));

    expect(await listed(manual.tenant.tenantId, manual.projectId)).toMatchObject({ suggestedAppSlug });
  });
});

describe('no readable address is offered', () => {
  it('before the App first goes live', async () => {
    const tenant = await createTenant(app);
    const projectId = await createProject(app, tenant);

    expect(await listed(tenant.tenantId, projectId)).toMatchObject({ publicUrl: null, suggestedAppSlug: null });
  });

  it('for a Project that serves an External Service', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Boards', 'boards');
    const builderChatId = service.builderChatId;
    await db
      .insert(projectApps)
      .values({ projectEnvironmentId: builderChatId, projectId: builderChatId, name: 'Boards' });

    expect(await listed(admin.tenant.tenantId, builderChatId)).toMatchObject({
      publicUrl: null,
      suggestedAppSlug: null,
    });
  });
});
