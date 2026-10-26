import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import { configuration } from '../../src/config/configuration';
import { PublicApiSettings } from '../../src/external-services/configuration/public-api-settings';
import { PodService } from '../../src/pod/pod.service';
import { appAuthRouteRules } from '../../src/project/app-auth-route';
import { AppService } from '../../src/project/app.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectStatus } from '../../src/project/project.types';
import { resolveAppAddress } from '../../src/proxy/app-address';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { DomainTestModule } from '../support/domain-module';
import { EveryServiceAvailableModule } from '../support/every-service-available';
import { startFakePod, type FakePod } from '../support/fake-pod';
import type { FakePodService } from '../support/infra-fakes';
import { createProject, createTenant, type TenantFixture } from '../support/project-fixtures';
import { PublicApiConfigurationDoubleModule } from '../support/public-api-configuration-double';
import { traefikRuleMatches } from '../support/traefik-routing';
import { waitFor } from '../support/wait-for';

const CONTROL_TOKEN = 'proxy-control-token-for-app-address-tests';
const APPS = 'apps.addresses.test';

@Module({
  controllers: [ProxyController],
  providers: [{ provide: PublicApiSettings, useValue: { of: () => Promise.resolve(null) } }],
})
class ProxyTestModule {}

let pod: FakePod;
let app: NestFastifyApplication;
let pods: FakePodService;
let environments: ProjectEnvironmentService;

beforeAll(async () => {
  pod = await startFakePod();
  process.env.AGENT_PORT = String(pod.port);
  process.env.PROXY_CONTROL_TOKEN = CONTROL_TOKEN;
  process.env.APPS_HOSTNAME = APPS;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
      DomainTestModule,
      EveryServiceAvailableModule,
      PublicApiConfigurationDoubleModule,
      ProxyTestModule,
    ],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  pods = app.get<PodService, FakePodService>(PodService);
  environments = app.get(ProjectEnvironmentService);
});

afterAll(async () => {
  await app.close();
  await pod.stop().catch(() => undefined);
});

function ensureApp(host: string) {
  return app.inject({
    method: 'POST',
    url: '/api/internal/proxy/apps/ensure',
    headers: { 'x-proxy-control-token': CONTROL_TOKEN },
    payload: { host },
  });
}

async function runningProjectIn(tenant: TenantFixture): Promise<string> {
  const projectId = await createProject(app, tenant);
  const podName = pods.assignedPodName(projectId);
  await waitFor(() => pods.callsTo('waitForReady').some((call) => call.args.podName === podName));
  pods.markPodReady(podName, '127.0.0.1');
  await waitFor(async () => (await environments.findByIdOrNull(projectId))?.status === ProjectStatus.Active);
  return projectId;
}

describe('resolving an App address by its full host', () => {
  it('serves the bare environment id host', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`${projectId}.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      action: 'serve',
      environmentId: projectId,
      canonicalHost: `${projectId}-dev.${APPS}`,
      state: 'ready',
      upstream: expect.any(String),
    });
  });

  it('serves the environment id followed by its own Environment Slug', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`${projectId}-dev.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ action: 'serve', environmentId: projectId, state: 'ready' });
  });

  it('accepts the host in any letter case and with a port', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`${projectId}-DEV.${APPS.toUpperCase()}:8443`);

    expect(res.json()).toMatchObject({ action: 'serve', environmentId: projectId });
  });

  it('redirects an environment id with another suffix to its canonical host', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`${projectId}-prod.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      action: 'redirect',
      environmentId: projectId,
      canonicalHost: `${projectId}-dev.${APPS}`,
      protected: false,
    });
  });

  it('redirects a readable label ending in the App Short ID to the canonical host without waking the pod', async () => {
    const tenant = await createTenant(app);
    const projectId = await suspendedProjectIn(tenant);
    const wakesBefore = wakesOf(projectId).length;

    const res = await ensureApp(`anything-dev-${shortIdOf(projectId)}.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      action: 'redirect',
      environmentId: projectId,
      canonicalHost: `${projectId}-dev.${APPS}`,
      protected: false,
    });
    expect(wakesOf(projectId)).toHaveLength(wakesBefore);
    expect((await environments.findById(projectId)).status).toBe(ProjectStatus.Suspended);
  });

  it('reads a label that merely starts like an unknown environment id by its App Short ID', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`${randomUUID()}-dev-${shortIdOf(projectId)}.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      action: 'redirect',
      environmentId: projectId,
      canonicalHost: `${projectId}-dev.${APPS}`,
      protected: false,
    });
  });

  it('wakes a sleeping environment it serves, as the per-environment route does', async () => {
    const tenant = await createTenant(app);
    const projectId = await suspendedProjectIn(tenant);
    const wakesBefore = wakesOf(projectId).length;

    const res = await ensureApp(`${projectId}-dev.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ action: 'serve', environmentId: projectId, state: 'starting' });
    await waitFor(() => wakesOf(projectId).length === wakesBefore + 1);
  });

  it.each([
    ['an unknown App Short ID', () => `anything-dev-0badc0de0bad.${APPS}`],
    ['an unknown environment id', () => `${randomUUID()}-dev.${APPS}`],
    ['a label with no App Short ID', () => `anything.${APPS}`],
  ])('answers 404 for %s', async (_case, host) => {
    expect((await ensureApp(host())).statusCode).toBe(404);
  });

  it.each([
    ['a trailing dot on a serving host', (id: string) => `${id}-dev.${APPS}.`],
    ['a trailing dot on a label ending in the App Short ID', (id: string) => `x-dev-${shortIdOf(id)}.${APPS}.`],
    ['only the first eight hex characters of the App Short ID', (id: string) => `x-dev-${shortIdOf(id, 8)}.${APPS}`],
    ['an underscore', (id: string) => `foo_bar-dev-${shortIdOf(id)}.${APPS}`],
    ['a leading dash', (id: string) => `-${shortIdOf(id)}.${APPS}`],
    ['a trailing dash', (id: string) => `${id}-.${APPS}`],
    ['a label longer than DNS allows', (id: string) => `${'a'.repeat(60)}-${shortIdOf(id)}.${APPS}`],
  ])('answers 404 for a known environment under a host with %s', async (_case, host) => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    expect((await ensureApp(host(projectId))).statusCode).toBe(404);
  });

  it.each([ProjectStatus.Pending, ProjectStatus.Claiming])(
    'answers 404 rather than redirect for an environment still %s in the warm pool',
    async (status) => {
      const tenant = await createTenant(app);
      const projectId = await runningProjectIn(tenant);
      await environments.patch(projectId, { status });

      expect((await ensureApp(`x-${shortIdOf(projectId)}.${APPS}`)).statusCode).toBe(404);
      expect((await ensureApp(`${projectId}-prod.${APPS}`)).statusCode).toBe(404);
    }
  );

  it('answers 404 for a known environment under a foreign domain', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    expect((await ensureApp(`${projectId}-dev.apps.elsewhere.test`)).statusCode).toBe(404);
    expect((await ensureApp(`${projectId}-dev.${APPS}.elsewhere.test`)).statusCode).toBe(404);
  });

  it('requires the proxy control token', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/proxy/apps/ensure',
      payload: { host: `${projectId}.${APPS}` },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("a protected App's sign-in", () => {
  it('runs on every apps-domain host the backend serves or redirects for the App', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);
    await app.get(AppService).upsertProjectApp(projectId, projectId, { name: 'Warehouse', description: null });
    await environments.patch(projectId, { authMode: 'managed' });
    const env = await environments.findById(projectId);
    const rules = appAuthRouteRules(env, APPS);

    const answered: string[] = [];
    for (const host of hostsAround(env.id, env.shortId)) {
      const res = await ensureApp(host);
      if (res.statusCode === 201 && res.json().environmentId === env.id) answered.push(host);
    }

    expect(answered).toEqual(expect.arrayContaining([`warehouse-dev-${env.shortId}.${APPS}`, `${env.id}.${APPS}`]));
    expect(answered.filter((host) => !rules.some((rule) => traefikRuleMatches(rule, host)))).toEqual([]);
  });

  it.each([
    ['public', false],
    ['managed', true],
    ['manual', true],
  ] as const)('is reported to the proxy for %s App Auth on serve and redirect answers', async (authMode, expected) => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);
    await environments.patch(projectId, { authMode });

    const served = await ensureApp(`${projectId}-dev.${APPS}`);
    const redirected = await ensureApp(`${projectId}-prod.${APPS}`);

    expect(served.json()).toMatchObject({ action: 'serve', environmentId: projectId, protected: expected });
    expect(redirected.json()).toMatchObject({ action: 'redirect', environmentId: projectId, protected: expected });
  });
});

describe('the in-product preview host', () => {
  it('serves the environment by its id and never redirects', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`${projectId}.preview.${APPS}`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ action: 'serve', environmentId: projectId, state: 'ready' });
  });

  it.each([
    ['the id with an Environment Slug', (id: string) => `${id}-dev.preview.${APPS}`],
    ['a label ending in the App Short ID', (id: string) => `x-dev-${shortIdOf(id)}.preview.${APPS}`],
    ['another subdomain', (id: string) => `${id}.staging.${APPS}`],
    ['a deeper subdomain', (id: string) => `a.${id}.preview.${APPS}`],
  ])('answers 404 for %s', async (_case, host) => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    expect((await ensureApp(host(projectId))).statusCode).toBe(404);
  });
});

describe('a deployment that serves previews on a domain of its own', () => {
  const domains = { appsHostname: APPS, previewAppsHostname: 'preview.example-org.test' };

  it('serves the preview host on that domain by id', async () => {
    const tenant = await createTenant(app);
    const projectId = await createProject(app, tenant);

    const address = await resolveAppAddress(`${projectId}.preview.example-org.test`, domains, environments);

    expect(address).toMatchObject({ action: 'serve', env: { id: projectId } });
  });

  it('answers nothing on the preview subdomain of the apps domain', async () => {
    const tenant = await createTenant(app);
    const projectId = await createProject(app, tenant);

    expect(await resolveAppAddress(`${projectId}.preview.${APPS}`, domains, environments)).toBeNull();
  });
});

describe('the App Short ID', () => {
  it('is the first twelve hex characters of the environment id', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);

    const res = await ensureApp(`whatever-${shortIdOf(projectId)}.${APPS}`);

    expect(res.json()).toMatchObject({ environmentId: projectId });
  });

  it('grows by two hex characters when its first twelve are taken', async () => {
    const tenant = await createTenant(app);
    const projectId = await runningProjectIn(tenant);
    const neighbourId = await environmentSharingTheFirstTwelveHexOf(projectId);

    const first = await ensureApp(`x-${shortIdOf(projectId)}.${APPS}`);
    const second = await ensureApp(`x-${shortIdOf(neighbourId, 14)}.${APPS}`);

    expect(first.json()).toMatchObject({ environmentId: projectId });
    expect(second.json()).toEqual({
      action: 'redirect',
      environmentId: neighbourId,
      canonicalHost: `${neighbourId}.${APPS}`,
      protected: false,
    });
  });
});

function shortIdOf(environmentId: string, length = 12): string {
  return environmentId.replaceAll('-', '').slice(0, length);
}

function hostsAround(environmentId: string, shortId: string): string[] {
  const labels = [
    `warehouse-dev-${shortId}`,
    `old-name-dev-${shortId}`,
    `x-${shortId}`,
    shortId,
    `-${shortId}`,
    `${shortId}-`,
    `foo_bar-dev-${shortId}`,
    `a--b-${shortId}`,
    environmentId,
    `${environmentId}-dev`,
    `${environmentId}-prod`,
    `${environmentId}-x-0badc0de0bad`,
    `${environmentId}x`,
    `${randomUUID()}-dev-${shortId}`,
  ];
  return labels
    .map((label) => `${label}.${APPS}`)
    .flatMap((host) => [
      host,
      host.toUpperCase(),
      `${host}:443`,
      `${host}.`,
      `${host}.:443`,
      `${host}..`,
      `${host}:`,
      `${host}:abc`,
      `a.${host}`,
      `${host}.evil.test`,
    ]);
}

function wakesOf(environmentId: string) {
  return pods.callsTo('createAssignedPod').filter((call) => call.args.environmentId === environmentId);
}

async function suspendedProjectIn(tenant: TenantFixture): Promise<string> {
  const projectId = await runningProjectIn(tenant);
  await pods.deletePod(pods.assignedPodName(projectId));
  await environments.patch(projectId, { status: ProjectStatus.Suspended, podIp: null });
  return projectId;
}

async function environmentSharingTheFirstTwelveHexOf(projectId: string): Promise<string> {
  const differentThirteenthHex = projectId[14] === '0' ? '1' : '0';
  const id = `${projectId.slice(0, 14)}${differentThirteenthHex}${projectId.slice(15)}`;
  await db.insert(projectEnvironments).values({
    id,
    projectId,
    environmentId: null,
    directory: `projects/${id}`,
    platformVersion: '0.0.0-test',
    status: ProjectStatus.Suspended,
  });
  return id;
}
