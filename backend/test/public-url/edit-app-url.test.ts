import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectApps, projectEnvironments } from '../../db/schema';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectController } from '../../src/project/project.controller';
import { ProjectService } from '../../src/project/project.service';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import { createCustomService, ensureExternalServiceBuilder } from '../support/custom-services';
import { tenantAdmin } from '../support/external-service-fixtures';
import {
  addMember,
  addNamedEnvironment,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';

const CONTROL_TOKEN = 'proxy-control-token-for-edit-app-url-tests';
const APPS = 'apps.edit-url.test';

@Module({ controllers: [ProxyController, ProjectController] })
class EditUrlRoutes {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;

beforeAll(async () => {
  harness = await createExternalServicesTestApp({
    env: { PROXY_CONTROL_TOKEN: CONTROL_TOKEN, APPS_HOSTNAME: APPS },
    extraModules: [EditUrlRoutes],
  });
  app = harness.app;
});

afterAll(async () => {
  await harness.close();
});

interface AppFixture {
  tenant: TenantFixture;
  owner: MemberFixture;
  projectId: string;
  environmentId: string;
}

async function liveApp(name = 'Equipment Monitor'): Promise<AppFixture> {
  const tenant = await createTenant(app);
  const owner = await addMember(app, tenant, ['can_edit_app_details']);
  const projectId = await createProject(app, tenant);
  const fixture = { tenant, owner, projectId, environmentId: projectId };
  await reportLive(fixture, name);
  return fixture;
}

async function reportLive(env: Omit<AppFixture, 'owner'>, name: string): Promise<void> {
  const key = await app.get(GatewayKeyService).createKey(env.projectId, env.environmentId, env.tenant.tenantId);
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${key}` },
    payload: { live: true, name },
  });
  expect(res.statusCode, res.body).toBe(201);
}

function editUrl(env: AppFixture, appSlug: unknown, headers = env.owner.headers) {
  return app.inject({
    method: 'PATCH',
    url: `/api/projects/${env.projectId}/app`,
    headers,
    payload: { environmentId: env.environmentId, appSlug },
  });
}

async function publicUrlOf(env: AppFixture): Promise<string | null | undefined> {
  const listed = await app.get(ProjectService).listEnvironments(env.projectId, env.tenant.tenantId);
  return listed.find((entry) => entry.id === env.environmentId)?.publicUrl;
}

function ensureApp(host: string) {
  return app.inject({
    method: 'POST',
    url: '/api/internal/proxy/apps/ensure',
    headers: { 'x-proxy-control-token': CONTROL_TOKEN },
    payload: { host },
  });
}

function shortIdOf(environmentId: string): string {
  return environmentId.replaceAll('-', '').slice(0, 12);
}

describe('Edit URL', () => {
  it('moves the Public URL to the chosen App Slug and redirects the old address to it', async () => {
    const dev = await liveApp('Equipment Monitor');

    const saved = await editUrl(dev, 'warehouse');

    expect(saved.statusCode, saved.body).toBe(200);
    const readableHost = `warehouse-dev-${shortIdOf(dev.projectId)}.${APPS}`;
    expect(await publicUrlOf(dev)).toBe(`https://${readableHost}/`);
    const old = await ensureApp(`equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}`);
    expect(old.json()).toEqual({
      action: 'redirect',
      environmentId: dev.projectId,
      canonicalHost: readableHost,
      protected: false,
    });
  });

  it('lists the App Slug and App Short ID a client needs to preview the address', async () => {
    const dev = await liveApp('Equipment Monitor');
    await editUrl(dev, 'warehouse');

    const listed = await app.get(ProjectService).listEnvironments(dev.projectId, dev.tenant.tenantId);

    expect(listed.find((entry) => entry.id === dev.environmentId)).toMatchObject({
      slug: 'dev',
      appSlug: 'warehouse',
      shortId: shortIdOf(dev.projectId),
    });
  });

  it.each([
    ['Warehouse', 'Use only lowercase letters, digits and dashes'],
    ['-warehouse', "Can't start or end with a dash"],
    ['warehouse-', "Can't start or end with a dash"],
    ['ware_house', 'Use only lowercase letters, digits and dashes'],
    ['', 'Enter the readable part of the address'],
    ['a'.repeat(47), 'At most 46 characters in Development'],
    ['6713b7a5-1c2d-4e5f-8a9b-0c1d2e3f4a5b-warehouse', "Can't start with a UUID"],
    ['xn--80ak6aa92e', "Can't have dashes as the 3rd and 4th characters"],
    ['ab--cd', "Can't have dashes as the 3rd and 4th characters"],
  ])('refuses "%s": %s', async (appSlug, message) => {
    const dev = await liveApp();

    const refused = await editUrl(dev, appSlug);

    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe(message);
    expect(await publicUrlOf(dev)).toBe(`https://equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}/`);
  });

  it('accepts an App Slug of exactly the length budget', async () => {
    const dev = await liveApp();

    const saved = await editUrl(dev, 'a'.repeat(46));

    expect(saved.statusCode, saved.body).toBe(200);
    expect(await publicUrlOf(dev)).toBe(`https://${'a'.repeat(46)}-dev-${shortIdOf(dev.projectId)}.${APPS}/`);
  });

  it('measures the length budget against a 26-character Environment Slug', async () => {
    const dev = await liveApp();
    const environmentName = 'Abcdefghijklmnopqrstuvwxyz';
    const environmentId = await addNamedEnvironment(app, dev.tenant, dev.projectId, environmentName);
    const custom = { ...dev, environmentId };
    await reportLive(custom, 'Equipment Monitor');

    const refused = await editUrl(custom, 'a'.repeat(24));
    const saved = await editUrl(custom, 'a'.repeat(23));

    expect(refused.json().message).toBe(`At most 23 characters in ${environmentName}`);
    expect(saved.statusCode, saved.body).toBe(200);
  });

  it('lets two Apps share an App Slug', async () => {
    const first = await liveApp();
    const second = await liveApp();

    expect((await editUrl(first, 'warehouse')).statusCode).toBe(200);
    expect((await editUrl(second, 'warehouse')).statusCode).toBe(200);
  });
});

describe('who and what may Edit URL', () => {
  it('refuses a caller without editAppDetails', async () => {
    const dev = await liveApp();
    const viewer = await addMember(app, dev.tenant, ['can_use_public_api']);

    const refused = await editUrl(dev, 'warehouse', viewer.headers);

    expect(refused.statusCode).toBe(403);
    expect(await publicUrlOf(dev)).toBe(`https://equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}/`);
  });

  it('refuses an environment that has not gone live', async () => {
    const tenant = await createTenant(app);
    const owner = await addMember(app, tenant, ['can_edit_app_details']);
    const projectId = await createProject(app, tenant);

    const refused = await editUrl({ tenant, owner, projectId, environmentId: projectId }, 'warehouse');

    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toMatch(/^APP_NOT_DETECTED/);
  });

  it('refuses a Project that serves an External Service', async () => {
    await ensureExternalServiceBuilder();
    const admin = await tenantAdmin(app);
    const owner = await addMember(app, admin.tenant, ['can_edit_app_details', 'can_manage_tenant_external_services']);
    const service = await createCustomService(app, admin, 'Boards', 'boards');
    const builder = {
      tenant: admin.tenant,
      owner,
      projectId: service.builderChatId,
      environmentId: service.builderChatId,
    };
    await reportLive(builder, 'Boards');

    const refused = await editUrl(builder, 'boards');

    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toBe('A Project that serves an External Service has no Public URL to edit');
  });
});

describe('an App with manual App Auth left on its legacy host', () => {
  async function manualAuthAppOnLegacyHost(): Promise<AppFixture> {
    const dev = await liveApp();
    await db.update(projectApps).set({ slug: null }).where(eq(projectApps.projectEnvironmentId, dev.environmentId));
    await db
      .update(projectEnvironments)
      .set({ authMode: 'manual' })
      .where(eq(projectEnvironments.id, dev.environmentId));
    return dev;
  }

  it('switches to the readable host after Edit URL, and the Auth dialog lists its callback beside both legacy ones', async () => {
    const dev = await manualAuthAppOnLegacyHost();
    expect(await publicUrlOf(dev)).toBe(`https://${dev.projectId}-dev.${APPS}/`);

    const saved = await editUrl(dev, 'warehouse');

    expect(saved.statusCode, saved.body).toBe(200);
    const readableHost = `warehouse-dev-${shortIdOf(dev.projectId)}.${APPS}`;
    expect(await publicUrlOf(dev)).toBe(`https://${readableHost}/`);
    const auth = await app.get(ProjectService).getAuth(dev.projectId, dev.environmentId, dev.tenant.tenantId);
    expect(auth.callbackUrls).toEqual([
      `https://${readableHost}/oidc/callback`,
      `https://${dev.projectId}-dev.${APPS}/oidc/callback`,
      `https://${dev.projectId}.${APPS}/oidc/callback`,
    ]);
  });
});
