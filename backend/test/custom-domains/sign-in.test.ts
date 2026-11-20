import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { customDomains } from '../../db/schema';
import { CustomDomainCluster } from '../../src/custom-domain/custom-domain-cluster';
import { CustomDomainModule } from '../../src/custom-domain/custom-domain.module';
import { PUBLIC_DNS } from '../../src/custom-domain/public-dns';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { AppAuthRouteReconciler } from '../../src/project/app-auth-route.reconciler';
import { ProjectAuthService } from '../../src/project/project-auth.service';
import { ProjectController } from '../../src/project/project.controller';
import { ProjectService } from '../../src/project/project.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { SignInProvidersModule } from '../../src/sign-in-provider/sign-in-provider.module';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import {
  addMember,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { waitFor } from '../support/wait-for';
import { fakeKube as kube } from './support/fake-kube';
import { FakePublicDns } from './support/fake-public-dns';

vi.mock('../../src/common/k8s-client', async () => {
  const { fakeKube } = await import('./support/fake-kube.js');
  return { loadKubeConfig: () => ({ makeApiClient: () => fakeKube }) };
});

const APPS = 'apps.sign-in.test';
const NAMESPACE = 'opsiforce-sign-in-test';
const ENTRA = {
  discoveryUrl: 'https://login.microsoftonline.com/example-org/v2.0',
  clientId: 'example-client',
  clientSecret: 'example-secret-1',
};

@Module({ controllers: [ProjectController] })
class AppRoutes {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
const dns = new FakePublicDns().zone('example-org.com');

beforeAll(async () => {
  const appAuth = new ProjectAuthService(
    new ConfigService({
      k8sNamespace: NAMESPACE,
      appsHostname: APPS,
      webappServiceName: 'proxy-app',
      webappServicePort: 3002,
      oidcPluginSecret: 'cookie-encryption-secret-for-test',
    })
  );
  harness = await createExternalServicesTestApp({
    env: { APPS_HOSTNAME: APPS, K8S_NAMESPACE: NAMESPACE, CUSTOM_DOMAINS_CLUSTER_ISSUER: 'test-issuer' },
    extraModules: [CustomDomainModule, SignInProvidersModule, AppRoutes],
    providers: [
      { provide: PUBLIC_DNS, useValue: dns },
      { provide: ProjectAuthService, useValue: appAuth },
    ],
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
  url: string;
  defaultAddress: string;
}

async function newApp(): Promise<AppFixture> {
  const tenant = await createTenant(app);
  const owner = await addMember(app, tenant, [
    'can_manage_custom_domains',
    'can_manage_project_auth_settings',
    'can_manage_tenant_sign_in_providers',
    'can_delete_project',
  ]);
  const projectId = await createProject(app, tenant);
  const key = await app.get(GatewayKeyService).createKey(projectId, projectId, tenant.tenantId);
  const reported = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${key}` },
    payload: { live: true, name: 'Equipment Monitor' },
  });
  expect(reported.statusCode, reported.body).toBe(201);
  const url = `/api/projects/${projectId}/environments/${projectId}/domains`;
  const listed = await app.inject({ method: 'GET', url, headers: owner.headers });
  expect(listed.statusCode, listed.body).toBe(200);
  return { tenant, owner, projectId, environmentId: projectId, url, defaultAddress: listed.json().defaultAddress };
}

async function addProvider(fixture: AppFixture): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/sign-in-providers',
    headers: fixture.owner.headers,
    payload: { name: `Example staff ${randomUUID()}`, ...ENTRA },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json().id;
}

async function setAuth(fixture: AppFixture, payload: Record<string, unknown>): Promise<void> {
  const saved = await app.inject({
    method: 'PUT',
    url: `/api/projects/${fixture.projectId}/environments/${fixture.environmentId}/auth`,
    headers: fixture.owner.headers,
    payload,
  });
  expect(saved.statusCode, saved.body).toBe(200);
}

async function issuingDomain(fixture: AppFixture): Promise<string> {
  const hostname = `shop-${randomUUID().slice(0, 8)}.example-org.com`;
  dns.cname(hostname, fixture.defaultAddress);
  const added = await app.inject({
    method: 'POST',
    url: fixture.url,
    headers: fixture.owner.headers,
    payload: { hostname },
  });
  expect(added.statusCode, added.body).toBe(201);
  return added.json().id;
}

async function connectedDomain(fixture: AppFixture): Promise<string> {
  const domainId = await issuingDomain(fixture);
  kube.issue(`opsiforce-domain-${domainId}`);
  const refreshed = await app.inject({
    method: 'POST',
    url: `${fixture.url}/refresh`,
    headers: fixture.owner.headers,
  });
  expect(refreshed.statusCode, refreshed.body).toBe(201);
  return domainId;
}

async function redirectToMain(fixture: AppFixture, domainId: string): Promise<void> {
  const set = await app.inject({
    method: 'PATCH',
    url: `${fixture.url}/${domainId}`,
    headers: fixture.owner.headers,
    payload: { redirectsToMain: true },
  });
  expect(set.statusCode, set.body).toBe(200);
}

const STRIP = { name: 'opsiforce-strip-identity-headers', namespace: NAMESPACE };

function middlewaresOnRouteOf(domainId: string): unknown[] {
  const routes = (kube.object('ingressroutes', `opsiforce-domain-${domainId}`)?.spec.routes ?? []) as {
    middlewares: unknown[];
  }[];
  return routes.flatMap((route) => route.middlewares);
}

function oidcPluginOf(middlewareName: string) {
  return (kube.object('middlewares', middlewareName)?.spec as { plugin?: Record<string, Record<string, unknown>> })
    ?.plugin?.['traefik-oidc-auth'];
}

describe('a Custom domain of an App that signs visitors in through a Sign-in provider', () => {
  it("signs them in on the domain itself, with the provider's settings, its own callback and a host-only cookie", async () => {
    const fixture = await newApp();
    const providerId = await addProvider(fixture);
    await setAuth(fixture, { mode: 'provider', signInProviderId: providerId });

    const domainId = await connectedDomain(fixture);

    const signIn = `opsiforce-project-${fixture.environmentId}-oidc-domains`;
    expect(middlewaresOnRouteOf(domainId)).toEqual([STRIP, { name: signIn, namespace: NAMESPACE }]);
    expect(oidcPluginOf(signIn)).toMatchObject({
      Provider: { Url: ENTRA.discoveryUrl, ClientId: ENTRA.clientId, ClientSecret: ENTRA.clientSecret },
      CallbackUri: '/oidc/callback',
      CookieNamePrefix: `_opsiforce_sp_${providerId}`,
      SessionCookie: { Secure: true },
    });
    expect(oidcPluginOf(signIn)?.SessionCookie).not.toHaveProperty('Domain');
  });

  it('keeps that sign-in only while the App has a connected domain', async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'provider', signInProviderId: await addProvider(fixture) });
    const domains = [await connectedDomain(fixture), await connectedDomain(fixture)];
    const signIn = () => kube.object('middlewares', `opsiforce-project-${fixture.environmentId}-oidc-domains`);
    const remove = async (domainId: string) => {
      const removed = await app.inject({
        method: 'DELETE',
        url: `${fixture.url}/${domainId}`,
        headers: fixture.owner.headers,
      });
      expect(removed.statusCode, removed.body).toBe(200);
    };

    await remove(domains[0]);
    expect(signIn()).toBeDefined();

    await remove(domains[1]);
    expect(signIn()).toBeUndefined();
  });

  it('is deleted with the last domain, even one that never connected', async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'provider', signInProviderId: await addProvider(fixture) });
    const domainId = await issuingDomain(fixture);
    const signIn = () => kube.object('middlewares', `opsiforce-project-${fixture.environmentId}-oidc-domains`);
    expect(signIn()).toBeDefined();

    const removed = await app.inject({
      method: 'DELETE',
      url: `${fixture.url}/${domainId}`,
      headers: fixture.owner.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(signIn()).toBeUndefined();
  });

  it('is deleted with the Project', async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'provider', signInProviderId: await addProvider(fixture) });
    await connectedDomain(fixture);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${fixture.projectId}`,
      headers: fixture.owner.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(kube.object('middlewares', `opsiforce-project-${fixture.environmentId}-oidc-domains`)).toBeUndefined();
  });

  it('takes the new settings on the domain too when the provider is saved', async () => {
    const fixture = await newApp();
    const providerId = await addProvider(fixture);
    await setAuth(fixture, { mode: 'provider', signInProviderId: providerId });
    await connectedDomain(fixture);

    const saved = await app.inject({
      method: 'PATCH',
      url: `/api/sign-in-providers/${providerId}`,
      headers: fixture.owner.headers,
      payload: { clientId: 'example-client-2', clientSecret: 'example-secret-2' },
    });

    expect(saved.statusCode, saved.body).toBe(200);
    expect(oidcPluginOf(`opsiforce-project-${fixture.environmentId}-oidc-domains`)).toMatchObject({
      Provider: { ClientId: 'example-client-2', ClientSecret: 'example-secret-2' },
      CallbackUri: '/oidc/callback',
    });
  });
});

describe('a Custom domain of an App with manual App Auth', () => {
  it("signs visitors in through the environment's own middleware, which already completes sign-in on each host", async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'manual', config: ENTRA });

    const domainId = await connectedDomain(fixture);

    const gate = `opsiforce-project-${fixture.environmentId}-oidc`;
    expect(middlewaresOnRouteOf(domainId)).toEqual([STRIP, { name: gate, namespace: NAMESPACE }]);
    expect(oidcPluginOf(gate)?.CallbackUri).toBe('/oidc/callback');
    expect(kube.object('middlewares', `${gate}-domains`)).toBeUndefined();
  });

  it('puts that sign-in on a domain still issuing its certificate while the App has no Main domain', async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'manual', config: ENTRA });

    const domainId = await issuingDomain(fixture);

    expect(middlewaresOnRouteOf(domainId)).toEqual([
      STRIP,
      { name: `opsiforce-project-${fixture.environmentId}-oidc`, namespace: NAMESPACE },
    ]);
  });
});

async function blocksAnother(pid: number): Promise<boolean> {
  const [row] = await db.execute<{ blocking: boolean }>(
    sql`select exists (select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocking`
  );
  return row.blocking;
}

async function waitsBehindOneItBlocks(pid: number): Promise<boolean> {
  const [row] = await db.execute<{ waiting: boolean }>(
    sql`select exists (
      select 1 from pg_stat_activity waiter, pg_stat_activity blocked
      where ${pid} = any(pg_blocking_pids(blocked.pid)) and blocked.pid = any(pg_blocking_pids(waiter.pid))
    ) as waiting`
  );
  return row.waiting;
}

async function heldUpAtRowOf<T>(
  domainId: string,
  request: () => Promise<T>,
  meanwhile: () => Promise<void>
): Promise<T> {
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = await new Promise<number>((held, failed) => {
    db.transaction(async (tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select().from(customDomains).where(eq(customDomains.id, domainId)).for('update');
      held(pid);
      await released;
    }).catch(failed);
  });
  const answered = request();
  await waitFor(() => blocksAnother(holder));
  const changed = meanwhile();
  await waitFor(() => waitsBehindOneItBlocks(holder));
  release?.();
  const answer = await answered;
  await changed;
  return answer;
}

describe('changing App Auth', () => {
  const MARKER = { name: 'opsiforce-custom-domain-unprotected', namespace: NAMESPACE };
  const gateOf = (fixture: AppFixture) => ({
    name: `opsiforce-project-${fixture.environmentId}-oidc`,
    namespace: NAMESPACE,
  });
  const signInOf = (fixture: AppFixture) => ({
    name: `opsiforce-project-${fixture.environmentId}-oidc-domains`,
    namespace: NAMESPACE,
  });
  const redirectOf = (fixture: AppFixture) => ({
    name: `opsiforce-project-${fixture.environmentId}-to-main`,
    namespace: NAMESPACE,
  });

  async function appWithTwoDomains() {
    const fixture = await newApp();
    const domains = [await connectedDomain(fixture), await connectedDomain(fixture)];
    await redirectToMain(fixture, domains[1]);
    return { fixture, middlewares: () => domains.flatMap(middlewaresOnRouteOf) };
  }

  it("puts the App's sign-in on its Main domain the moment it turns protected, and takes it off when it turns public", async () => {
    const { fixture, middlewares } = await appWithTwoDomains();
    expect(middlewares()).toEqual([MARKER, redirectOf(fixture)]);

    await setAuth(fixture, { mode: 'manual', config: ENTRA });
    expect(middlewares()).toEqual([STRIP, gateOf(fixture), redirectOf(fixture)]);

    await setAuth(fixture, { mode: 'public' });
    expect(middlewares()).toEqual([MARKER, redirectOf(fixture)]);
  });

  it('writes the sign-in for the domains when it turns to a Sign-in provider, and deletes it when it turns away', async () => {
    const { fixture, middlewares } = await appWithTwoDomains();

    await setAuth(fixture, { mode: 'provider', signInProviderId: await addProvider(fixture) });
    expect(middlewares()).toEqual([STRIP, signInOf(fixture), redirectOf(fixture)]);
    expect(oidcPluginOf(signInOf(fixture).name)?.CallbackUri).toBe('/oidc/callback');

    await setAuth(fixture, { mode: 'manual', config: ENTRA });
    expect(middlewares()).toEqual([STRIP, gateOf(fixture), redirectOf(fixture)]);
    expect(kube.object('middlewares', signInOf(fixture).name)).toBeUndefined();
  });

  describe('while Make main or Remove rewrites the routes', () => {
    it("ends with the new mode's sign-in on the new Main domain when the App turns protected meanwhile", async () => {
      const fixture = await newApp();
      const [mainId, otherId] = [await connectedDomain(fixture), await connectedDomain(fixture)];

      const made = await heldUpAtRowOf(
        mainId,
        () => app.inject({ method: 'POST', url: `${fixture.url}/${otherId}/main`, headers: fixture.owner.headers }),
        () => setAuth(fixture, { mode: 'manual', config: ENTRA })
      );

      expect(made.statusCode, made.body).toBe(201);
      expect(middlewaresOnRouteOf(otherId)).toEqual([STRIP, gateOf(fixture)]);
    });

    it("ends with the new mode's marker on the next Main domain when the App turns public meanwhile", async () => {
      const fixture = await newApp();
      const [mainId, nextId] = [await connectedDomain(fixture), await connectedDomain(fixture)];
      await setAuth(fixture, { mode: 'manual', config: ENTRA });

      const removed = await heldUpAtRowOf(
        mainId,
        () => app.inject({ method: 'DELETE', url: `${fixture.url}/${mainId}`, headers: fixture.owner.headers }),
        () => setAuth(fixture, { mode: 'public' })
      );

      expect(removed.statusCode, removed.body).toBe(200);
      expect(middlewaresOnRouteOf(nextId)).toEqual([MARKER]);
    });
  });

  it('follows the App Auth an environment inherits from another', async () => {
    const source = await newApp();
    await setAuth(source, { mode: 'provider', signInProviderId: await addProvider(source) });
    const { fixture, middlewares } = await appWithTwoDomains();

    await app
      .get(ProjectService)
      .inheritAuth(
        { id: source.environmentId },
        await app.get(ProjectEnvironmentService).findById(fixture.environmentId)
      );

    expect(middlewares()).toEqual([STRIP, signInOf(fixture), redirectOf(fixture)]);
    expect(oidcPluginOf(signInOf(fixture).name)?.CallbackUri).toBe('/oidc/callback');
  });
});

describe('the domain list', () => {
  async function callbacksOf(fixture: AppFixture) {
    const listed = await app.inject({ method: 'GET', url: fixture.url, headers: fixture.owner.headers });
    expect(listed.statusCode, listed.body).toBe(200);
    return listed
      .json()
      .items.map((item: { hostname: string; signInCallback: string | null }) => [item.hostname, item.signInCallback]);
  }

  it('gives every domain the sign-in callback to register while App Auth is on, and none while the App is public', async () => {
    const fixture = await newApp();
    await connectedDomain(fixture);
    await connectedDomain(fixture);
    const [first, second] = (await callbacksOf(fixture)).map(([hostname]: string[]) => hostname);

    expect(await callbacksOf(fixture)).toEqual([
      [first, null],
      [second, null],
    ]);

    await setAuth(fixture, { mode: 'manual', config: ENTRA });

    expect(await callbacksOf(fixture)).toEqual([
      [first, `https://${first}/oidc/callback`],
      [second, `https://${second}/oidc/callback`],
    ]);
  });
});

async function drift(domainId: string, middlewares: unknown[]): Promise<void> {
  const name = `opsiforce-domain-${domainId}`;
  const route = kube.object('ingressroutes', name);
  if (!route) throw new Error(`No route ${name}`);
  for (const rule of route.spec.routes as Record<string, unknown>[]) rule.middlewares = middlewares;
  await kube.replaceNamespacedCustomObject({ plural: 'ingressroutes', name, body: route });
}

describe('the start-up rewrite of App Auth routes', () => {
  const MARKER = 'opsiforce-custom-domain-unprotected';

  function rewriteAtStartUp(): Promise<void> {
    return new AppAuthRouteReconciler(
      app.get(ProjectEnvironmentService),
      app.get(ProjectAuthService),
      app.get(CustomDomainCluster)
    ).reconcileAll();
  }

  it("puts a protected App's sign-in back on a domain route that lost it, and writes the marker back", async () => {
    const fixture = await newApp();
    const drifted = await connectedDomain(fixture);
    const intact = await connectedDomain(fixture);
    await redirectToMain(fixture, intact);
    const redirect = `opsiforce-project-${fixture.environmentId}-to-main`;
    await setAuth(fixture, { mode: 'manual', config: ENTRA });
    await drift(drifted, [{ name: MARKER, namespace: NAMESPACE }]);
    await kube.deleteNamespacedCustomObject({ plural: 'middlewares', name: MARKER });
    await kube.deleteNamespacedCustomObject({ plural: 'middlewares', name: redirect });
    const intactWrites = kube.actionsOn('ingressroutes', `opsiforce-domain-${intact}`).length;

    await rewriteAtStartUp();

    const gate = { name: `opsiforce-project-${fixture.environmentId}-oidc`, namespace: NAMESPACE };
    expect(middlewaresOnRouteOf(drifted)).toEqual([STRIP, gate]);
    expect(kube.object('middlewares', MARKER)?.spec).toEqual({
      headers: { customRequestHeaders: { 'X-Opsiforce-Unprotected-Route': '1' } },
    });
    expect(kube.object('middlewares', redirect)?.spec).toHaveProperty('redirectRegex');
    expect(kube.actionsOn('ingressroutes', `opsiforce-domain-${intact}`)).toHaveLength(intactWrites);
  });

  it('puts the sign-in back on the route of a domain still issuing its certificate', async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'manual', config: ENTRA });
    const domainId = await issuingDomain(fixture);
    await drift(domainId, [{ name: MARKER, namespace: NAMESPACE }]);

    await rewriteAtStartUp();

    expect(middlewaresOnRouteOf(domainId)).toEqual([
      STRIP,
      { name: `opsiforce-project-${fixture.environmentId}-oidc`, namespace: NAMESPACE },
    ]);
  });

  it("moves a Sign-in provider App's domain route onto the domain's own sign-in, writing it when it is missing", async () => {
    const fixture = await newApp();
    await setAuth(fixture, { mode: 'provider', signInProviderId: await addProvider(fixture) });
    const domainId = await connectedDomain(fixture);
    const environmentGate = `opsiforce-project-${fixture.environmentId}-oidc`;
    await drift(domainId, [{ name: environmentGate, namespace: NAMESPACE }]);
    await kube.deleteNamespacedCustomObject({ plural: 'middlewares', name: `${environmentGate}-domains` });

    await rewriteAtStartUp();

    expect(middlewaresOnRouteOf(domainId)).toEqual([
      STRIP,
      { name: `${environmentGate}-domains`, namespace: NAMESPACE },
    ]);
    expect(oidcPluginOf(`${environmentGate}-domains`)?.CallbackUri).toBe('/oidc/callback');
  });
});
