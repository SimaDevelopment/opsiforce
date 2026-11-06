import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { projectEnvironments } from '../../db/schema';
import { CustomDomainCluster } from '../../src/custom-domain/custom-domain-cluster';
import { CustomDomainModule } from '../../src/custom-domain/custom-domain.module';
import { PUBLIC_DNS } from '../../src/custom-domain/public-dns';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectController } from '../../src/project/project.controller';
import { ProxyController } from '../../src/proxy/proxy.controller';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import {
  addMember,
  addNamedEnvironment,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { fakeKube as kube } from './support/fake-kube';
import { FakePublicDns } from './support/fake-public-dns';

vi.mock('../../src/common/k8s-client', async () => {
  const { fakeKube } = await import('./support/fake-kube.js');
  return { loadKubeConfig: () => ({ makeApiClient: () => fakeKube }) };
});

const APPS = 'apps.connect.test';
const NAMESPACE = 'opsiforce-connect-test';
const ISSUER = 'test-issuer';
const CONTROL_TOKEN = 'proxy-control-token-for-custom-domain-tests';
const MANAGE = 'can_manage_custom_domains';

@Module({ controllers: [ProjectController, ProxyController] })
class AppRoutes {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
const dns = new FakePublicDns().zone('example-org.com');

beforeAll(async () => {
  harness = await createExternalServicesTestApp({
    env: {
      APPS_HOSTNAME: APPS,
      K8S_NAMESPACE: NAMESPACE,
      CUSTOM_DOMAINS_CLUSTER_ISSUER: ISSUER,
      PROXY_CONTROL_TOKEN: CONTROL_TOKEN,
    },
    extraModules: [CustomDomainModule, AppRoutes],
    providers: [{ provide: PUBLIC_DNS, useValue: dns }],
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
    MANAGE,
    'can_delete_project',
    'can_delete_environment',
    'can_use_public_api',
  ]);
  const projectId = await createProject(app, tenant);
  return liveAppIn({ tenant, owner, projectId }, projectId);
}

async function liveAppIn(
  { tenant, owner, projectId }: Pick<AppFixture, 'tenant' | 'owner' | 'projectId'>,
  environmentId: string
): Promise<AppFixture> {
  const key = await app.get(GatewayKeyService).createKey(projectId, environmentId, tenant.tenantId);
  const reported = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${key}` },
    payload: { live: true, name: 'Equipment Monitor' },
  });
  expect(reported.statusCode, reported.body).toBe(201);
  const url = `/api/projects/${projectId}/environments/${environmentId}/domains`;
  const listed = await app.inject({ method: 'GET', url, headers: owner.headers });
  expect(listed.statusCode, listed.body).toBe(200);
  return { tenant, owner, projectId, environmentId, url, defaultAddress: listed.json().defaultAddress };
}

const LOAD_BALANCER = '203.0.113.10';
const CERT_MANAGER_FAILURE =
  'The certificate request has failed to complete and will be retried: Failed to wait for order resource ' +
  '"opsiforce-domain-1-1" to become ready: order is in "invalid" state: 403 urn:ietf:params:acme:error:unauthorized';

function subdomainName(): string {
  return `shop-${randomUUID().slice(0, 8)}.example-org.com`;
}

function bareName(): string {
  const name = `example-org-${randomUUID().slice(0, 8)}.com`;
  dns.zone(name);
  return name;
}

async function add(fixture: AppFixture, hostname: string): Promise<string> {
  const added = await app.inject({
    method: 'POST',
    url: fixture.url,
    headers: fixture.owner.headers,
    payload: { hostname },
  });
  expect(added.statusCode, added.body).toBe(201);
  return added.json().id;
}

async function issuingDomain(fixture: AppFixture, hostname = subdomainName()): Promise<string> {
  dns.cname(hostname, fixture.defaultAddress);
  return add(fixture, hostname);
}

async function itemOf(fixture: AppFixture, domainId: string) {
  const listed = await app.inject({ method: 'GET', url: fixture.url, headers: fixture.owner.headers });
  expect(listed.statusCode, listed.body).toBe(200);
  return listed.json().items.find((item: { id: string }) => item.id === domainId);
}

async function protect(fixture: AppFixture): Promise<void> {
  await db
    .update(projectEnvironments)
    .set({ authMode: 'manual' })
    .where(eq(projectEnvironments.id, fixture.environmentId));
}

async function refresh(fixture: AppFixture) {
  const refreshed = await app.inject({
    method: 'POST',
    url: `${fixture.url}/refresh`,
    headers: fixture.owner.headers,
  });
  expect(refreshed.statusCode, refreshed.body).toBe(201);
  return refreshed.json();
}

function check(fixture: AppFixture, domainId: string) {
  return app.inject({ method: 'POST', url: `${fixture.url}/${domainId}/check`, headers: fixture.owner.headers });
}

function certificateOf(domainId: string) {
  return kube.object('certificates', `opsiforce-domain-${domainId}`);
}

function routeOf(domainId: string) {
  return kube.object('ingressroutes', `opsiforce-domain-${domainId}`);
}

function issue(domainId: string): void {
  kube.issue(`opsiforce-domain-${domainId}`);
}

async function connectedDomain(fixture: AppFixture, hostname = subdomainName()): Promise<string> {
  const domainId = await issuingDomain(fixture, hostname);
  issue(domainId);
  await refresh(fixture);
  return domainId;
}

describe('a Check that passes', () => {
  it('orders a certificate for the domain from the configured issuer', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    dns.cname(hostname, fixture.defaultAddress);

    const domainId = await add(fixture, hostname);

    expect(certificateOf(domainId)).toMatchObject({
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: {
        name: `opsiforce-domain-${domainId}`,
        labels: { 'opsiforce.io/custom-domain': domainId, 'opsiforce.io/environment': fixture.environmentId },
      },
      spec: {
        dnsNames: [hostname],
        secretName: `opsiforce-domain-${domainId}-tls`,
        issuerRef: { kind: 'ClusterIssuer', name: ISSUER },
        privateKey: { rotationPolicy: 'Always' },
      },
    });
  });

  it('names the www of a bare domain on its certificate too', async () => {
    const fixture = await newApp();
    const hostname = bareName();
    dns
      .address(fixture.defaultAddress, LOAD_BALANCER)
      .address(hostname, LOAD_BALANCER)
      .cname(`www.${hostname}`, fixture.defaultAddress);

    const domainId = await add(fixture, hostname);

    expect(certificateOf(domainId)?.spec.dnsNames).toEqual([hostname, `www.${hostname}`]);
  });

  it('is the only way to a certificate: a domain whose DNS is not right yet gets none', async () => {
    const fixture = await newApp();

    const domainId = await add(fixture, subdomainName());

    expect(certificateOf(domainId)).toBeUndefined();
    expect(routeOf(domainId)).toBeUndefined();
  });

  it("writes the domain's route at once, before its certificate is ready, naming the Secret cert-manager will fill", async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    dns.cname(hostname, fixture.defaultAddress);

    const domainId = await add(fixture, hostname);

    expect(await itemOf(fixture, domainId)).toMatchObject({ status: 'issuing' });
    expect(certificateOf(domainId)?.status).toBeUndefined();
    expect(routeOf(domainId)).toMatchObject({
      metadata: {
        labels: { 'opsiforce.io/custom-domain': domainId, 'opsiforce.io/environment': fixture.environmentId },
      },
      spec: {
        entryPoints: ['websecure'],
        tls: { secretName: certificateOf(domainId)?.spec.secretName },
        routes: [
          {
            match: `Host(\`${hostname}\`)`,
            middlewares: [{ name: 'opsiforce-custom-domain-unprotected', namespace: NAMESPACE }],
          },
        ],
      },
    });
  });
});

describe('refreshing the list while a domain issues its certificate', () => {
  it('connects it once its certificate is ready, and answers the list', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    const domainId = await issuingDomain(fixture, hostname);
    issue(domainId);

    const refreshed = await refresh(fixture);

    expect(refreshed).toMatchObject({
      defaultAddress: fixture.defaultAddress,
      items: [{ id: domainId, status: 'connected', isMain: true, failureReason: null }],
    });
    expect(routeOf(domainId)).toMatchObject({
      spec: { routes: [{ match: `Host(\`${hostname}\`)` }], tls: { secretName: `opsiforce-domain-${domainId}-tls` } },
    });
  });

  it('makes the first domain of the App to connect its Main domain, and only that one', async () => {
    const fixture = await newApp();
    const first = await issuingDomain(fixture);
    const second = await issuingDomain(fixture);
    issue(second);
    await refresh(fixture);
    issue(first);

    await refresh(fixture);

    expect(await itemOf(fixture, second)).toMatchObject({ status: 'connected', isMain: true });
    expect(await itemOf(fixture, first)).toMatchObject({ status: 'connected', isMain: false });
  });

  it('leaves it issuing, its route in place, while cert-manager is still at work', async () => {
    const fixture = await newApp();
    const domainId = await issuingDomain(fixture);
    kube.startIssuing(`opsiforce-domain-${domainId}`);

    await refresh(fixture);

    expect(await itemOf(fixture, domainId)).toMatchObject({ status: 'issuing', isMain: false });
    expect(routeOf(domainId)).toBeDefined();
  });

  it("shows Certificate failed with cert-manager's reason when issuing fails", async () => {
    const fixture = await newApp();
    const domainId = await issuingDomain(fixture);
    kube.failIssuing(`opsiforce-domain-${domainId}`, CERT_MANAGER_FAILURE);

    await refresh(fixture);

    expect(await itemOf(fixture, domainId)).toMatchObject({ status: 'failed', failureReason: CERT_MANAGER_FAILURE });
  });

  it('orders the certificate again when it has gone missing', async () => {
    const fixture = await newApp();
    const domainId = await issuingDomain(fixture);
    await kube.deleteNamespacedCustomObject({ plural: 'certificates', name: `opsiforce-domain-${domainId}` });

    await refresh(fixture);

    expect(certificateOf(domainId)).toMatchObject({ spec: { secretName: `opsiforce-domain-${domainId}-tls` } });
    expect(await itemOf(fixture, domainId)).toMatchObject({ status: 'issuing' });
  });
});

describe('Check on a domain issuing its certificate', () => {
  it('reads the certificate instead of DNS, connecting the domain once it is ready', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    const domainId = await issuingDomain(fixture, hostname);
    const { checkedAt } = await itemOf(fixture, domainId);
    issue(domainId);
    dns.cname(hostname, 'example-org.base44.app');

    const checked = await check(fixture, domainId);

    expect(checked.statusCode, checked.body).toBe(201);
    expect(checked.json()).toMatchObject({ status: 'connected', isMain: true, checkedAt });
  });

  it('settles it as failed when cert-manager gave up', async () => {
    const fixture = await newApp();
    const domainId = await issuingDomain(fixture);
    kube.failIssuing(`opsiforce-domain-${domainId}`, CERT_MANAGER_FAILURE);

    const checked = await check(fixture, domainId);

    expect(checked.json()).toMatchObject({ status: 'failed', failureReason: CERT_MANAGER_FAILURE });
  });
});

describe("a connected domain's route", () => {
  it('carries the unprotected marker for a public App, which the backend keeps in its own namespace', async () => {
    const fixture = await newApp();

    const domainId = await connectedDomain(fixture);

    expect(routeOf(domainId)?.spec.routes).toMatchObject([
      { middlewares: [{ name: 'opsiforce-custom-domain-unprotected', namespace: NAMESPACE }] },
    ]);
    expect(kube.object('middlewares', 'opsiforce-custom-domain-unprotected')?.spec).toEqual({
      headers: { customRequestHeaders: { 'X-Opsiforce-Unprotected-Route': '1' } },
    });
  });
});

describe('Try again on a domain whose certificate failed', () => {
  async function failedDomain(fixture: AppFixture, hostname: string): Promise<string> {
    const domainId = await issuingDomain(fixture, hostname);
    kube.failIssuing(`opsiforce-domain-${domainId}`, CERT_MANAGER_FAILURE);
    await refresh(fixture);
    return domainId;
  }

  const tryAgain = check;

  it("orders a fresh certificate once Check passes, which resets cert-manager's back-off", async () => {
    const fixture = await newApp();
    const domainId = await failedDomain(fixture, subdomainName());

    const retried = await tryAgain(fixture, domainId);

    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json()).toMatchObject({ status: 'issuing', failureReason: null });
    expect(kube.actionsOn('certificates', `opsiforce-domain-${domainId}`)).toEqual(['create', 'delete', 'create']);
    expect(certificateOf(domainId)?.status).toBeUndefined();
  });

  it('keeps it failed, certificate untouched, while DNS no longer names the App', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    const domainId = await failedDomain(fixture, hostname);
    dns.cname(hostname, 'example-org.base44.app');

    const retried = await tryAgain(fixture, domainId);

    expect(retried.json()).toMatchObject({
      status: 'failed',
      failureReason: CERT_MANAGER_FAILURE,
      dnsAnswer: 'CNAME → example-org.base44.app',
    });
    expect(kube.actionsOn('certificates', `opsiforce-domain-${domainId}`)).toEqual(['create']);
  });

  it('is the only way to a fresh certificate: refreshing the list leaves the failed domain alone', async () => {
    const fixture = await newApp();
    const domainId = await failedDomain(fixture, subdomainName());
    await issuingDomain(fixture);

    await refresh(fixture);

    expect(await itemOf(fixture, domainId)).toMatchObject({ status: 'failed', failureReason: CERT_MANAGER_FAILURE });
    expect(kube.actionsOn('certificates', `opsiforce-domain-${domainId}`)).toEqual(['create']);
  });
});

function objectsOf(domainId: string) {
  const labels = { 'opsiforce.io/custom-domain': domainId };
  return {
    routes: kube.labelled('ingressroutes', labels).length,
    certificates: kube.labelled('certificates', labels).length,
    secret: kube.hasSecret(`opsiforce-domain-${domainId}-tls`),
  };
}

const EVERY_OBJECT = { routes: 1, certificates: 1, secret: true };
const NO_OBJECT = { routes: 0, certificates: 0, secret: false };

describe('removing', () => {
  it('a domain deletes its route, its certificate and its Secret, then the domain', async () => {
    const fixture = await newApp();
    const domainId = await connectedDomain(fixture);
    expect(objectsOf(domainId)).toEqual(EVERY_OBJECT);

    const removed = await app.inject({
      method: 'DELETE',
      url: `${fixture.url}/${domainId}`,
      headers: fixture.owner.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(objectsOf(domainId)).toEqual(NO_OBJECT);
    expect(await itemOf(fixture, domainId)).toBeUndefined();
  });

  it('an environment removes the objects of every one of its domains', async () => {
    const dev = await newApp();
    const staging = await liveAppIn(dev, await addNamedEnvironment(app, dev.tenant, dev.projectId, 'Staging'));
    const connected = await connectedDomain(staging);
    const issuing = await issuingDomain(staging);
    const devDomain = await connectedDomain(dev);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${dev.projectId}/environments/${staging.environmentId}`,
      headers: dev.owner.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(objectsOf(connected)).toEqual(NO_OBJECT);
    expect(objectsOf(issuing)).toEqual(NO_OBJECT);
    expect(objectsOf(devDomain)).toEqual(EVERY_OBJECT);
  });

  it('an environment whose domain objects cannot be deleted stays, with its domains, so deleting it can be tried again', async () => {
    const dev = await newApp();
    const staging = await liveAppIn(dev, await addNamedEnvironment(app, dev.tenant, dev.projectId, 'Staging'));
    const domainId = await connectedDomain(staging);
    const deleteStaging = () =>
      app.inject({
        method: 'DELETE',
        url: `/api/projects/${dev.projectId}/environments/${staging.environmentId}`,
        headers: dev.owner.headers,
      });
    kube.failNext('delete', 'certificates');

    expect((await deleteStaging()).statusCode).not.toBe(200);
    expect(await itemOf(staging, domainId)).toMatchObject({ status: 'connected' });

    expect((await deleteStaging()).statusCode).toBe(200);
    expect(objectsOf(domainId)).toEqual(NO_OBJECT);
  });

  it.each([
    [
      'an environment',
      (dev: AppFixture, staging: AppFixture) => `/api/projects/${dev.projectId}/environments/${staging.environmentId}`,
    ],
    ['a Project', (dev: AppFixture) => `/api/projects/${dev.projectId}`],
  ])('%s being deleted takes a domain added after its first cleanup with it, objects included', async (_, urlOf) => {
    const dev = await newApp();
    const staging = await liveAppIn(dev, await addNamedEnvironment(app, dev.tenant, dev.projectId, 'Staging'));
    const cleanUp = CustomDomainCluster.prototype.removeEnvironment;
    let lateId = '';
    const cleanups = vi
      .spyOn(CustomDomainCluster.prototype, 'removeEnvironment')
      .mockImplementation(async function (this: CustomDomainCluster, environmentId, thenWithin) {
        await cleanUp.call(this, environmentId, thenWithin);
        if (environmentId === staging.environmentId && !thenWithin) lateId = await issuingDomain(staging);
      });

    const removed = await app.inject({ method: 'DELETE', url: urlOf(dev, staging), headers: dev.owner.headers });
    cleanups.mockRestore();

    expect(removed.statusCode, removed.body).toBe(200);
    expect(lateId).not.toBe('');
    expect(objectsOf(lateId)).toEqual(NO_OBJECT);
  });

  it('a Project removes the objects of every domain of its environments', async () => {
    const dev = await newApp();
    const staging = await liveAppIn(dev, await addNamedEnvironment(app, dev.tenant, dev.projectId, 'Staging'));
    const domains = [await connectedDomain(dev), await connectedDomain(staging)];

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${dev.projectId}`,
      headers: dev.owner.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(domains.map(objectsOf)).toEqual([NO_OBJECT, NO_OBJECT]);
  });
});

function everywhere(url: string) {
  return { environmentList: url, publicApi: url, gateway: url };
}

describe('the Public URL', () => {
  async function publicUrlsOf(fixture: AppFixture) {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/projects/${fixture.projectId}/environments`,
      headers: fixture.owner.headers,
    });
    const publicApi = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${fixture.projectId}`,
      headers: fixture.owner.headers,
    });
    const key = await app
      .get(GatewayKeyService)
      .createKey(fixture.projectId, fixture.environmentId, fixture.tenant.tenantId);
    const gateway = await app.inject({
      method: 'GET',
      url: '/api/gateway/app/public-url',
      headers: { authorization: `Bearer ${key}` },
    });
    expect([listed.statusCode, publicApi.statusCode, gateway.statusCode], publicApi.body).toEqual([200, 200, 200]);
    const ofEnvironment = (environments: { id: string; publicUrl: string | null }[]) =>
      environments.find((environment) => environment.id === fixture.environmentId)?.publicUrl;
    return {
      environmentList: ofEnvironment(listed.json()),
      publicApi: ofEnvironment(publicApi.json().environments),
      gateway: gateway.json().publicUrl,
    };
  }

  it('becomes the Main domain once it connects, wherever the platform hands it out', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    const domainId = await issuingDomain(fixture, hostname);
    const whileIssuing = await publicUrlsOf(fixture);
    issue(domainId);

    await refresh(fixture);

    expect(whileIssuing).toEqual(everywhere(`https://${fixture.defaultAddress}/`));
    expect(await publicUrlsOf(fixture)).toEqual(everywhere(`https://${hostname}/`));
  });

  it('leaves the environment list naming the Default address beside it, the one Edit URL changes', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    await connectedDomain(fixture, hostname);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/projects/${fixture.projectId}/environments`,
      headers: fixture.owner.headers,
    });

    expect(listed.statusCode, listed.body).toBe(200);
    const environment = listed.json().find((listedOne: { id: string }) => listedOne.id === fixture.environmentId);
    expect(environment).toMatchObject({ publicUrl: `https://${hostname}/`, defaultAddress: fixture.defaultAddress });
  });

  it('goes back to the Default address once the Main domain is removed', async () => {
    const fixture = await newApp();
    const domainId = await connectedDomain(fixture);

    await app.inject({ method: 'DELETE', url: `${fixture.url}/${domainId}`, headers: fixture.owner.headers });

    expect(await publicUrlsOf(fixture)).toEqual(everywhere(`https://${fixture.defaultAddress}/`));
  });
});

describe('the App address lookup', () => {
  function ensureApp(host: string) {
    return app.inject({
      method: 'POST',
      url: '/api/internal/proxy/apps/ensure',
      headers: { 'x-proxy-control-token': CONTROL_TOKEN },
      payload: { host },
    });
  }

  it('serves the App on its connected Main domain, telling the proxy whether the App is protected', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    await connectedDomain(fixture, hostname);
    await protect(fixture);

    const res = await ensureApp(`${hostname.toUpperCase()}:443`);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      action: 'serve',
      environmentId: fixture.environmentId,
      canonicalHost: hostname,
      protected: true,
    });
  });

  it('keeps serving the Default address, never redirecting it to the Main domain', async () => {
    const fixture = await newApp();
    await connectedDomain(fixture);

    const res = await ensureApp(fixture.defaultAddress);

    expect(res.json()).toMatchObject({ action: 'serve', canonicalHost: fixture.defaultAddress });
  });

  it('serves the App on a domain still issuing its certificate while the App has no Main domain, sending its www to it', async () => {
    const fixture = await newApp();
    const hostname = bareName();
    dns
      .address(fixture.defaultAddress, LOAD_BALANCER)
      .address(hostname, LOAD_BALANCER)
      .cname(`www.${hostname}`, fixture.defaultAddress);
    await add(fixture, hostname);
    await protect(fixture);

    const [apex, www] = [await ensureApp(hostname), await ensureApp(`www.${hostname}`)];

    expect(apex.statusCode, apex.body).toBe(201);
    expect(apex.json()).toMatchObject({
      action: 'serve',
      environmentId: fixture.environmentId,
      canonicalHost: hostname,
      protected: true,
    });
    expect(www.json()).toMatchObject({ action: 'redirect', canonicalHost: hostname });
  });

  it('serves a domain still issuing once the App has a Main domain, and sends it on there once set to redirect, as its route does', async () => {
    const fixture = await newApp();
    const main = subdomainName();
    await connectedDomain(fixture, main);
    const hostname = subdomainName();
    const domainId = await issuingDomain(fixture, hostname);
    const served = await ensureApp(hostname);

    const set = await app.inject({
      method: 'PATCH',
      url: `${fixture.url}/${domainId}`,
      headers: fixture.owner.headers,
      payload: { redirectsToMain: true },
    });

    expect(set.statusCode, set.body).toBe(200);
    expect(served.json()).toMatchObject({ action: 'serve', canonicalHost: hostname });
    expect((await ensureApp(hostname)).json()).toMatchObject({ action: 'redirect', canonicalHost: main });
  });

  it.each([
    ['an unknown host', async () => subdomainName()],
    [
      'a domain waiting for DNS',
      async () => {
        const hostname = subdomainName();
        await add(await newApp(), hostname);
        return hostname;
      },
    ],
    [
      'a domain whose certificate failed',
      async () => {
        const fixture = await newApp();
        const hostname = subdomainName();
        const domainId = await issuingDomain(fixture, hostname);
        kube.failIssuing(`opsiforce-domain-${domainId}`, CERT_MANAGER_FAILURE);
        await refresh(fixture);
        return hostname;
      },
    ],
  ])('answers 404 for %s', async (_case, host) => {
    expect((await ensureApp(await host())).statusCode).toBe(404);
  });
});
