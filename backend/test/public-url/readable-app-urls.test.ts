import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import crypto, { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { environments, projectApps } from '../../db/schema';
import { EnvironmentService } from '../../src/environment/environment.service';
import { PRODUCTION_ENVIRONMENT_SLUG } from '../../src/environment/environment.types';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { PodService } from '../../src/pod/pod.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectService } from '../../src/project/project.service';
import { ProjectStatus } from '../../src/project/project.types';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { PublishService } from '../../src/publish/publish.service';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import { createCustomService, ensureExternalServiceBuilder } from '../support/custom-services';
import { tenantAdmin } from '../support/external-service-fixtures';
import { startFakePod, type FakePod } from '../support/fake-pod';
import type { FakePodService } from '../support/infra-fakes';
import {
  addNamedEnvironment,
  createAgent,
  createProject,
  createTenant,
  type TenantFixture,
} from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';

const CONTROL_TOKEN = 'proxy-control-token-for-readable-app-url-tests';
const APPS = 'apps.readable.test';

@Module({ controllers: [ProxyController] })
class ProxyTestModule {}

let pod: FakePod;
let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
let pods: FakePodService;

beforeAll(async () => {
  await ensureExternalServiceBuilder();
  pod = await startFakePod();
  harness = await createExternalServicesTestApp({
    env: { AGENT_PORT: String(pod.port), PROXY_CONTROL_TOKEN: CONTROL_TOKEN, APPS_HOSTNAME: APPS },
    extraModules: [ProxyTestModule],
  });
  app = harness.app;
  pods = app.get<PodService, FakePodService>(PodService);
});

afterAll(async () => {
  await harness.close();
  await pod.stop().catch(() => undefined);
});

interface ProjectEnvironmentFixture {
  tenant: TenantFixture;
  projectId: string;
  environmentId: string;
}

async function developmentOfNewProject(): Promise<ProjectEnvironmentFixture> {
  const tenant = await createTenant(app);
  const projectId = await createProject(app, tenant);
  return { tenant, projectId, environmentId: projectId };
}

async function reportLive(env: ProjectEnvironmentFixture, name: string): Promise<void> {
  const key = await app.get(GatewayKeyService).createKey(env.projectId, env.environmentId, env.tenant.tenantId);
  const res = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${key}` },
    payload: { live: true, name },
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function publicUrlOf(env: ProjectEnvironmentFixture): Promise<string | null | undefined> {
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

async function runningDevelopmentOfNewProject(): Promise<ProjectEnvironmentFixture> {
  const dev = await developmentOfNewProject();
  const podName = pods.assignedPodName(dev.environmentId);
  await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
  pods.markPodReady(podName, '127.0.0.1');
  const projectEnvironments = app.get(ProjectEnvironmentService);
  await waitFor(
    async () => (await projectEnvironments.findByIdOrNull(dev.environmentId))?.status === ProjectStatus.Active
  );
  return dev;
}

async function suspend(environmentId: string): Promise<void> {
  await pods.deletePod(pods.assignedPodName(environmentId));
  await app.get(ProjectEnvironmentService).patch(environmentId, { status: ProjectStatus.Suspended, podIp: null });
}

function podStartsOf(environmentId: string) {
  return pods.callsTo('createAssignedPod').filter((call) => call.args.environmentId === environmentId);
}

async function registryEnvironment(tenant: TenantFixture, slug: string): Promise<string> {
  const [environment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, tenant.tenantId), eq(environments.slug, slug)));
  return environment.id;
}

async function environmentTakingTheFirstTwelveHexOf(environmentId: string, projectId: string): Promise<void> {
  const differentThirteenthHex = environmentId[14] === '0' ? '1' : '0';
  const id = `${environmentId.slice(0, 14)}${differentThirteenthHex}${environmentId.slice(15)}`;
  await app.get(ProjectEnvironmentService).create({
    id,
    projectId,
    environmentId: null,
    isDefault: false,
    directory: `projects/${id}`,
    platformVersion: '0.0.0-test',
    status: ProjectStatus.Suspended,
  });
}

async function withoutAppSlug(environmentId: string): Promise<void> {
  await db.update(projectApps).set({ slug: null }).where(eq(projectApps.projectEnvironmentId, environmentId));
}

function shortIdOf(environmentId: string): string {
  return environmentId.replaceAll('-', '').slice(0, 12);
}

describe('an App going live', () => {
  it('has no Public URL before it first goes live', async () => {
    const dev = await developmentOfNewProject();

    expect(await publicUrlOf(dev)).toBeNull();
  });

  it('gets a readable Public URL from its name', async () => {
    const dev = await developmentOfNewProject();

    await reportLive(dev, 'Equipment Monitor');

    expect(await publicUrlOf(dev)).toBe(`https://equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}/`);
  });

  it('keeps its Public URL when the App is renamed afterwards', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');

    await reportLive(dev, 'Warehouse');

    expect(await publicUrlOf(dev)).toBe(`https://equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}/`);
  });

  it.each([
    ['Облік обладнання', 'oblik-obladnannya'],
    ['Їжак і щука', 'yizhak-i-shuka'],
    ['Équipement Café', 'equipement-cafe'],
    ['Equipment Monitor v2.0', 'equipment-monitor-v2-0'],
    ['设备监控', 'app'],
    [`${'a'.repeat(45)} tail`, 'a'.repeat(45)],
  ])('reads "%s" as %s', async (name, appSlug) => {
    const dev = await developmentOfNewProject();

    await reportLive(dev, name);

    expect(await publicUrlOf(dev)).toBe(`https://${appSlug}-dev-${shortIdOf(dev.projectId)}.${APPS}/`);
  });

  it('reads a name that starts with a uuid as app, so its address serves instead of looping to the legacy path', async () => {
    const dev = await developmentOfNewProject();

    await reportLive(dev, '6713b7a5-1c2d-4e5f-8a9b-0c1d2e3f4a5b report');

    const readableHost = `app-dev-${shortIdOf(dev.projectId)}.${APPS}`;
    expect(await publicUrlOf(dev)).toBe(`https://${readableHost}/`);
    expect((await ensureApp(readableHost)).json()).toMatchObject({ action: 'serve', canonicalHost: readableHost });
  });

  it('stays on its legacy host when its sign-in callbacks are registered with an outside identity provider', async () => {
    const dev = await developmentOfNewProject();
    const oidc = { clientId: 'client', clientSecret: 'secret', discoveryUrl: 'https://issuer.example' };
    await app
      .get(ProjectService)
      .updateAuth(dev.projectId, dev.environmentId, { mode: 'manual', config: oidc }, dev.tenant.tenantId);

    await reportLive(dev, 'Equipment Monitor');

    expect(await publicUrlOf(dev)).toBe(`https://${dev.projectId}-dev.${APPS}/`);
  });

  it('cuts a long name to what fits beside a 26-character Environment Slug', async () => {
    const dev = await developmentOfNewProject();
    const environmentSlug = 'abcdefghijklmnopqrstuvwxyz';
    const environmentId = await addNamedEnvironment(app, dev.tenant, dev.projectId, environmentSlug);
    const custom = { ...dev, environmentId };

    await reportLive(custom, `${'b'.repeat(22)} tail`);

    expect(await publicUrlOf(custom)).toBe(
      `https://${'b'.repeat(22)}-${environmentSlug}-${shortIdOf(environmentId)}.${APPS}/`
    );
  });
});

describe('copying the App Slug', () => {
  it('gives a published environment the App Slug of Development, not one from its current name', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    await reportLive(dev, 'Warehouse');
    const production = await registryEnvironment(dev.tenant, PRODUCTION_ENVIRONMENT_SLUG);

    const job = await app
      .get(PublishService)
      .publish(dev.projectId, dev.tenant.tenantId, { environmentId: production });
    const prod = { ...dev, environmentId: job.projectEnvironmentId };
    expect(job.publicUrl).toBeNull();
    expect(await publicUrlOf(prod)).toBeNull();
    await reportLive(prod, 'Warehouse');

    const expected = `https://equipment-monitor-prod-${shortIdOf(prod.environmentId)}.${APPS}/`;
    expect(await publicUrlOf(prod)).toBe(expected);
    const latestJob = await app.get(PublishService).getLatestJob(dev.projectId, production);
    expect(latestJob?.publicUrl).toBe(expected);
  });

  it("gives a duplicate's Development the source's App Slug with its own App Short ID", async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    await reportLive(dev, 'Warehouse');

    const copy = await app.get(ProjectService).duplicate(dev.projectId, dev.tenant.tenantId, undefined, null);

    expect(await publicUrlOf({ tenant: dev.tenant, projectId: copy.id, environmentId: copy.id })).toBe(
      `https://equipment-monitor-dev-${shortIdOf(copy.id)}.${APPS}/`
    );
  });

  it("gives a published environment an App Slug from its own name when Development's App has none", async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    await withoutAppSlug(dev.environmentId);
    const production = await registryEnvironment(dev.tenant, PRODUCTION_ENVIRONMENT_SLUG);
    const job = await app
      .get(PublishService)
      .publish(dev.projectId, dev.tenant.tenantId, { environmentId: production });
    const prod = { ...dev, environmentId: job.projectEnvironmentId };

    await reportLive(prod, 'Warehouse');

    expect(await publicUrlOf(prod)).toBe(`https://warehouse-prod-${shortIdOf(prod.environmentId)}.${APPS}/`);
  });

  it("gives a duplicate of an App without an App Slug one from the App's name", async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    await withoutAppSlug(dev.environmentId);

    const copy = await app.get(ProjectService).duplicate(dev.projectId, dev.tenant.tenantId, undefined, null);

    expect(await publicUrlOf({ tenant: dev.tenant, projectId: copy.id, environmentId: copy.id })).toBe(
      `https://equipment-monitor-dev-${shortIdOf(copy.id)}.${APPS}/`
    );
  });

  it('gives a duplicate whose sign-in callbacks are registered with an outside identity provider no App Slug', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    const oidc = { clientId: 'client', clientSecret: 'secret', discoveryUrl: 'https://issuer.example' };
    await app
      .get(ProjectService)
      .updateAuth(dev.projectId, dev.environmentId, { mode: 'manual', config: oidc }, dev.tenant.tenantId);

    const copy = await app.get(ProjectService).duplicate(dev.projectId, dev.tenant.tenantId, undefined, null);

    expect(await publicUrlOf({ tenant: dev.tenant, projectId: copy.id, environmentId: copy.id })).toBe(
      `https://${copy.id}-dev.${APPS}/`
    );
  });
});

describe('a copied App Slug that would overflow the 63-character label', () => {
  const FIFTY_CHARACTER_NAME = 'Quarterly Equipment Maintenance Scheduling Dashboard';

  async function publishedLive(dev: ProjectEnvironmentFixture, registryEnvironmentId: string) {
    const job = await app
      .get(PublishService)
      .publish(dev.projectId, dev.tenant.tenantId, { environmentId: registryEnvironmentId });
    const published = { ...dev, environmentId: job.projectEnvironmentId };
    await reportLive(published, 'Anything');
    return published;
  }

  it('is cut to fit when published to Production', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, FIFTY_CHARACTER_NAME);

    const prod = await publishedLive(dev, await registryEnvironment(dev.tenant, PRODUCTION_ENVIRONMENT_SLUG));

    expect(await publicUrlOf(prod)).toBe(
      `https://quarterly-equipment-maintenance-scheduling-da-prod-${shortIdOf(prod.environmentId)}.${APPS}/`
    );
  });

  it('is cut to fit when published to an environment with a long Environment Slug', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, FIFTY_CHARACTER_NAME);
    const staging = await app
      .get(EnvironmentService)
      .create(dev.tenant.tenantId, { name: 'Staging EU West', slug: 'staging-eu-west' });

    const published = await publishedLive(dev, staging.id);

    expect(await publicUrlOf(published)).toBe(
      `https://quarterly-equipment-maintenance-sc-staging-eu-west-${shortIdOf(published.environmentId)}.${APPS}/`
    );
  });

  it('is cut to fit a duplicate whose App Short ID grew past twelve characters', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, FIFTY_CHARACTER_NAME);
    const copyId = randomUUID();
    await environmentTakingTheFirstTwelveHexOf(copyId, dev.projectId);

    const randomUUIDs = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(copyId);
    const copy = await app.get(ProjectService).duplicate(dev.projectId, dev.tenant.tenantId, undefined, null);
    randomUUIDs.mockRestore();

    expect(copy.id).toBe(copyId);
    expect(await publicUrlOf({ tenant: dev.tenant, projectId: copy.id, environmentId: copy.id })).toBe(
      `https://quarterly-equipment-maintenance-scheduling-d-dev-${copyId.replaceAll('-', '').slice(0, 14)}.${APPS}/`
    );
  });
});

describe('an imported Project', () => {
  async function importedPublicUrl(appDetails: { name: string | null; appSlug?: string | null }) {
    const tenant = await createTenant(app);
    const imported = await app.get(ProjectService).createImportedProject({
      tenantId: tenant.tenantId,
      workspaceId: null,
      folderId: null,
      title: 'Imported',
      timezone: 'UTC',
      agentId: await createAgent(),
      importedAgent: null,
      description: null,
      settings: null,
      resources: null,
      appDetails: { description: null, ...appDetails },
      schedules: [],
      createdBy: null,
    });
    return {
      publicUrl: await publicUrlOf({ tenant, projectId: imported.id, environmentId: imported.id }),
      shortId: shortIdOf(imported.id),
    };
  }

  it('keeps the App Slug its export carried, with its own App Short ID', async () => {
    const { publicUrl, shortId } = await importedPublicUrl({ name: 'Warehouse Tracker', appSlug: 'warehouse' });

    expect(publicUrl).toBe(`https://warehouse-dev-${shortId}.${APPS}/`);
  });

  it('takes the App Slug from the App name when the export carries none', async () => {
    const { publicUrl, shortId } = await importedPublicUrl({ name: 'Equipment Monitor' });

    expect(publicUrl).toBe(`https://equipment-monitor-dev-${shortId}.${APPS}/`);
  });

  it('turns an App Slug edited in the export file into a valid one', async () => {
    const { publicUrl, shortId } = await importedPublicUrl({
      name: 'Warehouse',
      appSlug: `Ware House!${'x'.repeat(80)}`,
    });

    expect(publicUrl).toBe(`https://ware-house-${'x'.repeat(35)}-dev-${shortId}.${APPS}/`);
  });
});

describe('a Project that serves an External Service', () => {
  it('has no Public URL', async () => {
    const admin = await tenantAdmin(app);
    const service = await createCustomService(app, admin, 'Boards', 'boards');
    const builder = { tenant: admin.tenant, projectId: service.builderChatId, environmentId: service.builderChatId };
    await reportLive(builder, 'Boards');

    expect(await publicUrlOf(builder)).toBeNull();
  });
});

describe('a pod started after go-live', () => {
  it('gets the readable Public URL as APP_PUBLIC_URL', async () => {
    const dev = await runningDevelopmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    await suspend(dev.environmentId);
    const readableHost = `equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}`;

    await ensureApp(readableHost);

    await waitFor(() => podStartsOf(dev.environmentId).length === 2);
    expect(podStartsOf(dev.environmentId).map((call) => call.args.appPublicUrl)).toEqual([
      `https://${dev.projectId}-dev.${APPS}/`,
      `https://${readableHost}/`,
    ]);
  });
});

describe('the Auth dialog', () => {
  it('lists the sign-in callback of the readable address beside both legacy ones', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');

    const auth = await app.get(ProjectService).getAuth(dev.projectId, dev.environmentId, dev.tenant.tenantId);

    expect(auth.callbackUrls).toEqual([
      `https://equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}/oidc/callback`,
      `https://${dev.projectId}-dev.${APPS}/oidc/callback`,
      `https://${dev.projectId}.${APPS}/oidc/callback`,
    ]);
  });
});

describe('the readable address', () => {
  it('is the canonical host the proxy serves, and any other label ending in its id redirects to it', async () => {
    const dev = await developmentOfNewProject();
    await reportLive(dev, 'Equipment Monitor');
    const readableHost = `equipment-monitor-dev-${shortIdOf(dev.projectId)}.${APPS}`;

    const served = await ensureApp(readableHost);
    const outdated = await ensureApp(`warehouse-dev-${shortIdOf(dev.projectId)}.${APPS}`);
    const legacy = await ensureApp(`${dev.projectId}-dev.${APPS}`);

    expect(served.json()).toMatchObject({ action: 'serve', environmentId: dev.projectId, canonicalHost: readableHost });
    expect(outdated.json()).toEqual({
      action: 'redirect',
      environmentId: dev.projectId,
      canonicalHost: readableHost,
      protected: false,
    });
    expect(legacy.json()).toMatchObject({ action: 'serve', environmentId: dev.projectId, canonicalHost: readableHost });
  });
});
