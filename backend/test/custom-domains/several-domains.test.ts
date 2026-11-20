import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { CustomDomainCluster } from '../../src/custom-domain/custom-domain-cluster';
import { CustomDomainModule } from '../../src/custom-domain/custom-domain.module';
import { PUBLIC_DNS } from '../../src/custom-domain/public-dns';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { withEnvironmentAuthLock } from '../../src/project/environment-auth-lock';
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
import { traefikRedirect } from '../support/traefik-routing';
import { waitFor } from '../support/wait-for';
import { fakeKube as kube } from './support/fake-kube';
import { FakePublicDns } from './support/fake-public-dns';

vi.mock('../../src/common/k8s-client', async () => {
  const { fakeKube } = await import('./support/fake-kube.js');
  return { loadKubeConfig: () => ({ makeApiClient: () => fakeKube }) };
});

const APPS = 'apps.several.test';
const NAMESPACE = 'opsiforce-several-test';
const CONTROL_TOKEN = 'proxy-control-token-for-several-domain-tests';
const MANAGE = 'can_manage_custom_domains';
const MARKER = 'opsiforce-custom-domain-unprotected';
const LOAD_BALANCER = '203.0.113.10';

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
      CUSTOM_DOMAINS_CLUSTER_ISSUER: 'test-issuer',
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

async function newApp(tenant?: TenantFixture): Promise<AppFixture> {
  const inTenant = tenant ?? (await createTenant(app));
  const owner = await addMember(app, inTenant, [MANAGE, 'can_delete_project']);
  const projectId = await createProject(app, inTenant);
  return liveAppIn({ tenant: inTenant, owner, projectId }, projectId);
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

function subdomainName(): string {
  return `shop-${randomUUID().slice(0, 8)}.example-org.com`;
}

function bareName(): string {
  const name = `example-org-${randomUUID().slice(0, 8)}.com`;
  dns.zone(name);
  return name;
}

function pointAt(fixture: AppFixture, hostname: string, bare = false): void {
  if (!bare) {
    dns.cname(hostname, fixture.defaultAddress);
    return;
  }
  dns
    .address(fixture.defaultAddress, LOAD_BALANCER)
    .address(hostname, LOAD_BALANCER)
    .cname(`www.${hostname}`, fixture.defaultAddress);
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

async function refresh(fixture: AppFixture): Promise<void> {
  const refreshed = await app.inject({
    method: 'POST',
    url: `${fixture.url}/refresh`,
    headers: fixture.owner.headers,
  });
  expect(refreshed.statusCode, refreshed.body).toBe(201);
}

async function issuingDomain(fixture: AppFixture, hostname = subdomainName(), bare = false): Promise<string> {
  pointAt(fixture, hostname, bare);
  return add(fixture, hostname);
}

async function connectedDomain(fixture: AppFixture, hostname = subdomainName(), bare = false): Promise<string> {
  const domainId = await issuingDomain(fixture, hostname, bare);
  kube.issue(`opsiforce-domain-${domainId}`);
  await refresh(fixture);
  return domainId;
}

async function itemsOf(fixture: AppFixture) {
  const listed = await app.inject({ method: 'GET', url: fixture.url, headers: fixture.owner.headers });
  expect(listed.statusCode, listed.body).toBe(200);
  return listed.json().items as { id: string; hostname: string; status: string; isMain: boolean }[];
}

async function mainOf(fixture: AppFixture): Promise<string | undefined> {
  return (await itemsOf(fixture)).find((item) => item.isMain)?.hostname;
}

function makeMain(fixture: AppFixture, domainId: string, headers = fixture.owner.headers) {
  return app.inject({ method: 'POST', url: `${fixture.url}/${domainId}/main`, headers });
}

function remove(fixture: AppFixture, domainId: string) {
  return app.inject({ method: 'DELETE', url: `${fixture.url}/${domainId}`, headers: fixture.owner.headers });
}

function middlewaresOf(domainId: string): Record<string, string[]> {
  const route = kube.object('ingressroutes', `opsiforce-domain-${domainId}`);
  const routes = (route?.spec.routes ?? []) as { match: string; middlewares: { name: string }[] }[];
  return Object.fromEntries(
    routes.map((rule) => [/Host\(`([^`]+)`\)/.exec(rule.match)?.[1], rule.middlewares.map(({ name }) => name)])
  );
}

function redirectOf(fixture: AppFixture) {
  return kube.object('middlewares', `opsiforce-project-${fixture.environmentId}-to-main`);
}

function redirectsTo(fixture: AppFixture, from: string): string | null {
  const redirect = redirectOf(fixture)?.spec.redirectRegex as { regex: string; replacement: string } | undefined;
  return redirect ? traefikRedirect(redirect, from) : null;
}

async function publicUrlOf(fixture: AppFixture): Promise<string | null | undefined> {
  const listed = await app.inject({
    method: 'GET',
    url: `/api/projects/${fixture.projectId}/environments`,
    headers: fixture.owner.headers,
  });
  expect(listed.statusCode, listed.body).toBe(200);
  return listed.json().find((environment: { id: string }) => environment.id === fixture.environmentId)?.publicUrl;
}

function redirectName(fixture: AppFixture): string {
  return `opsiforce-project-${fixture.environmentId}-to-main`;
}

function withoutWwwName(fixture: AppFixture): string {
  return `opsiforce-project-${fixture.environmentId}-without-www`;
}

function setRedirect(fixture: AppFixture, domainId: string, redirectsToMain: unknown, headers = fixture.owner.headers) {
  return app.inject({
    method: 'PATCH',
    url: `${fixture.url}/${domainId}`,
    headers,
    payload: { redirectsToMain },
  });
}

async function redirectToMain(fixture: AppFixture, domainId: string): Promise<void> {
  const set = await setRedirect(fixture, domainId, true);
  expect(set.statusCode, set.body).toBe(200);
}

describe('the routes of domains issuing their certificates', () => {
  it('let every domain reach the App while none is the Main domain, then the first to connect sends on the others set to redirect', async () => {
    const fixture = await newApp();
    const [first, second] = [subdomainName(), subdomainName()];
    const firstId = await issuingDomain(fixture, first);
    const secondId = await issuingDomain(fixture, second);
    await redirectToMain(fixture, firstId);
    const beforeAnyConnects = { first: middlewaresOf(firstId), second: middlewaresOf(secondId) };
    kube.issue(`opsiforce-domain-${secondId}`);

    await refresh(fixture);

    expect(beforeAnyConnects).toEqual({ first: { [first]: [MARKER] }, second: { [second]: [MARKER] } });
    expect(await mainOf(fixture)).toBe(second);
    expect(middlewaresOf(secondId)).toEqual({ [second]: [MARKER] });
    expect(middlewaresOf(firstId)).toEqual({ [first]: [redirectName(fixture)] });
    expect(redirectsTo(fixture, `https://${first}/orders?page=2`)).toBe(`https://${second}/orders?page=2`);
  });

  it('let a domain that passes once the App has a Main domain reach the App on its own host, its www through it', async () => {
    const fixture = await newApp();
    const main = subdomainName();
    await connectedDomain(fixture, main);
    const bare = bareName();

    const bareId = await issuingDomain(fixture, bare, true);

    expect(middlewaresOf(bareId)).toEqual({
      [bare]: [MARKER],
      [`www.${bare}`]: [withoutWwwName(fixture)],
    });
    expect(redirectOf(fixture)).toBeUndefined();
  });
});

describe('Make main', () => {
  it('switches the Main domain, rewriting the redirect and every domain route, and the Public URL follows', async () => {
    const fixture = await newApp();
    const [first, second] = [subdomainName(), subdomainName()];
    const firstId = await connectedDomain(fixture, first);
    const secondId = await connectedDomain(fixture, second);
    await redirectToMain(fixture, firstId);
    await redirectToMain(fixture, secondId);
    const before = { first: middlewaresOf(firstId), second: middlewaresOf(secondId) };
    const redirectedBefore = redirectsTo(fixture, `https://${second}/orders?page=2`);

    const made = await makeMain(fixture, secondId);

    expect(made.statusCode, made.body).toBe(201);
    expect(made.json()).toMatchObject({ id: secondId, isMain: true, status: 'connected' });
    expect(before).toEqual({
      first: { [first]: [MARKER] },
      second: { [second]: [`opsiforce-project-${fixture.environmentId}-to-main`] },
    });
    expect(redirectedBefore).toBe(`https://${first}/orders?page=2`);
    expect(middlewaresOf(firstId)).toEqual({ [first]: [`opsiforce-project-${fixture.environmentId}-to-main`] });
    expect(middlewaresOf(secondId)).toEqual({ [second]: [MARKER] });
    expect(redirectsTo(fixture, `https://${first}/orders?page=2`)).toBe(`https://${second}/orders?page=2`);
    expect(await mainOf(fixture)).toBe(second);
    expect(await publicUrlOf(fixture)).toBe(`https://${second}/`);
  });
});

describe('Make main refusals', () => {
  it('refuses a domain that is not connected, and keeps the Main domain', async () => {
    const fixture = await newApp();
    const main = subdomainName();
    await connectedDomain(fixture, main);
    const waitingId = await add(fixture, subdomainName());

    const made = await makeMain(fixture, waitingId);

    expect(made.statusCode).toBe(409);
    expect(made.json().message).toBe('Only a connected domain can be the Main domain.');
    expect(await mainOf(fixture)).toBe(main);
  });

  it('refuses a member without can_manage_custom_domains', async () => {
    const fixture = await newApp();
    const main = subdomainName();
    await connectedDomain(fixture, main);
    const otherId = await connectedDomain(fixture);
    const reader = await addMember(app, fixture.tenant);

    const made = await makeMain(fixture, otherId, reader.headers);

    expect(made.statusCode).toBe(403);
    expect(await mainOf(fixture)).toBe(main);
  });
});

describe('removing the Main domain', () => {
  it('hands the role to the oldest other connected domain, rewriting the redirect and the routes', async () => {
    const fixture = await newApp();
    const firstId = await connectedDomain(fixture);
    await add(fixture, subdomainName());
    const [second, third] = [subdomainName(), subdomainName()];
    const secondId = await connectedDomain(fixture, second);
    const thirdId = await connectedDomain(fixture, third);
    await redirectToMain(fixture, thirdId);

    const removed = await remove(fixture, firstId);

    expect(removed.statusCode, removed.body).toBe(200);
    expect(await mainOf(fixture)).toBe(second);
    expect(middlewaresOf(secondId)).toEqual({ [second]: [MARKER] });
    expect(middlewaresOf(thirdId)).toEqual({ [third]: [`opsiforce-project-${fixture.environmentId}-to-main`] });
    expect(redirectsTo(fixture, `https://${third}/`)).toBe(`https://${second}/`);
    expect(await publicUrlOf(fixture)).toBe(`https://${second}/`);
  });

  it('leaves the App without one when no other domain is connected, deleting the redirect', async () => {
    const fixture = await newApp();
    const mainId = await connectedDomain(fixture);
    await redirectToMain(fixture, await issuingDomain(fixture));
    expect(redirectOf(fixture)).toBeDefined();

    await remove(fixture, mainId);

    expect(await mainOf(fixture)).toBeUndefined();
    expect(redirectOf(fixture)).toBeUndefined();
    expect(await publicUrlOf(fixture)).toBe(`https://${fixture.defaultAddress}/`);
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

const NO_OBJECT = { routes: 0, certificates: 0, secret: false };

async function itemOf(fixture: AppFixture, domainId: string) {
  return (await itemsOf(fixture)).find((item) => item.id === domainId);
}

describe('deleting the Project', () => {
  it("deletes its environments' redirects with their domains", async () => {
    const fixture = await newApp();
    await connectedDomain(fixture);
    await redirectToMain(fixture, await connectedDomain(fixture));
    expect(redirectOf(fixture)).toBeDefined();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${fixture.projectId}`,
      headers: fixture.owner.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(redirectOf(fixture)).toBeUndefined();
  });
});

async function blocksAnother(pid: number): Promise<boolean> {
  const [row] = await db.execute<{ blocking: boolean }>(
    sql`select exists (select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocking`
  );
  return row.blocking;
}

describe('another App passing Check for a domain', () => {
  it("takes it from another Organization's App, deleting that App's domain with its objects", async () => {
    const first = await newApp();
    const second = await newApp();
    const hostname = subdomainName();
    const firstId = await connectedDomain(first, hostname);
    pointAt(second, hostname);

    const secondId = await add(second, hostname);

    expect(await itemOf(second, secondId)).toMatchObject({ status: 'issuing' });
    expect(await itemOf(first, firstId)).toBeUndefined();
    expect(objectsOf(firstId)).toEqual(NO_OBJECT);
    expect(await publicUrlOf(first)).toBe(`https://${first.defaultAddress}/`);
  });

  it("waits for a rewrite holding the first App's lock before deleting anything, so nothing that rewrite writes survives", async () => {
    const first = await newApp();
    const second = await newApp();
    const hostname = subdomainName();
    const firstId = await connectedDomain(first, hostname);
    pointAt(second, hostname);
    let holder = 0;
    let signalHeld = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rewrite = withEnvironmentAuthLock(first.environmentId, async (tx, auth) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holder = pid;
      signalHeld();
      await released;
      await app.get(CustomDomainCluster).routeWithin(tx, first.environmentId, auth);
    });
    await held;

    const added = add(second, hostname);
    await waitFor(() => blocksAnother(holder));
    release();
    await rewrite;
    const secondId = await added;

    expect(await itemOf(second, secondId)).toMatchObject({ status: 'issuing' });
    expect(await itemOf(first, firstId)).toBeUndefined();
    expect(objectsOf(firstId)).toEqual(NO_OBJECT);
  });

  it('takes it between environments of one Project, deleting an issuing domain with its Certificate', async () => {
    const dev = await newApp();
    const staging = await liveAppIn(dev, await addNamedEnvironment(app, dev.tenant, dev.projectId, 'Staging'));
    const hostname = subdomainName();
    const devId = await issuingDomain(dev, hostname);
    expect(objectsOf(devId)).toMatchObject({ routes: 1, certificates: 1 });
    pointAt(staging, hostname);

    const stagingId = await add(staging, hostname);

    expect(await itemOf(staging, stagingId)).toMatchObject({ status: 'issuing' });
    expect(await itemOf(dev, devId)).toBeUndefined();
    expect(objectsOf(devId)).toEqual(NO_OBJECT);
  });

  it('takes a domain whose certificate failed', async () => {
    const first = await newApp();
    const second = await newApp();
    const hostname = subdomainName();
    const firstId = await issuingDomain(first, hostname);
    kube.failIssuing(`opsiforce-domain-${firstId}`, 'The certificate request has failed to complete.');
    await refresh(first);
    expect(await itemOf(first, firstId)).toMatchObject({ status: 'failed' });
    pointAt(second, hostname);

    await add(second, hostname);

    expect(await itemOf(first, firstId)).toBeUndefined();
    expect(objectsOf(firstId)).toEqual(NO_OBJECT);
  });

  it("hands the first App's Main domain role to its oldest other connected domain", async () => {
    const first = await newApp();
    const second = await newApp();
    const [moving, staying] = [subdomainName(), subdomainName()];
    await connectedDomain(first, moving);
    const stayingId = await connectedDomain(first, staying);
    pointAt(second, moving);

    await add(second, moving);

    expect(await mainOf(first)).toBe(staying);
    expect(middlewaresOf(stayingId)).toEqual({ [staying]: [MARKER] });
    expect(redirectOf(first)).toBeUndefined();
  });

  it('leaves the first App with no Main domain when none other is connected, its issuing domain reaching the App again', async () => {
    const first = await newApp();
    const second = await newApp();
    const [moving, issuing] = [subdomainName(), subdomainName()];
    await connectedDomain(first, moving);
    const issuingId = await issuingDomain(first, issuing);
    await redirectToMain(first, issuingId);
    expect(middlewaresOf(issuingId)).toEqual({ [issuing]: [redirectName(first)] });
    pointAt(second, moving);

    await add(second, moving);

    expect(await mainOf(first)).toBeUndefined();
    expect(redirectOf(first)).toBeUndefined();
    expect(middlewaresOf(issuingId)).toEqual({ [issuing]: [MARKER] });
  });

  it('takes a bare domain from an App whose www passes Check as a subdomain', async () => {
    const first = await newApp();
    const second = await newApp();
    const bare = bareName();
    const firstId = await connectedDomain(first, bare, true);
    pointAt(second, `www.${bare}`);

    const secondId = await add(second, `www.${bare}`);

    expect(await itemOf(second, secondId)).toMatchObject({ status: 'issuing' });
    expect(await itemOf(first, firstId)).toBeUndefined();
    expect(objectsOf(firstId)).toEqual(NO_OBJECT);
  });

  it('takes a www subdomain from an App when its bare parent passes Check elsewhere', async () => {
    const first = await newApp();
    const second = await newApp();
    const bare = bareName();
    const firstId = await issuingDomain(first, `www.${bare}`);
    pointAt(second, bare, true);

    const secondId = await add(second, bare);

    expect(await itemOf(second, secondId)).toMatchObject({ bare: true, status: 'issuing' });
    expect(await itemOf(first, firstId)).toBeUndefined();
    expect(objectsOf(firstId)).toEqual(NO_OBJECT);
  });

  it('leaves a domain another App is only waiting on where it is', async () => {
    const first = await newApp();
    const second = await newApp();
    const hostname = subdomainName();
    const firstId = await add(first, hostname);
    pointAt(second, hostname);

    await add(second, hostname);

    expect(await itemOf(first, firstId)).toMatchObject({ status: 'waiting' });
  });
});

describe('the App address lookup, for a route that has drifted', () => {
  function ensureApp(host: string) {
    return app.inject({
      method: 'POST',
      url: '/api/internal/proxy/apps/ensure',
      headers: { 'x-proxy-control-token': CONTROL_TOKEN },
      payload: { host },
    });
  }

  it("redirects another of the App's connected domains set to redirect to the Main domain, and serves one that is not", async () => {
    const fixture = await newApp();
    const [main, redirected, serving] = [subdomainName(), subdomainName(), subdomainName()];
    await connectedDomain(fixture, main);
    await redirectToMain(fixture, await connectedDomain(fixture, redirected));
    await connectedDomain(fixture, serving);

    const [sent, served] = [await ensureApp(`${redirected}:443`), await ensureApp(serving)];

    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json()).toMatchObject({
      action: 'redirect',
      environmentId: fixture.environmentId,
      canonicalHost: main,
    });
    expect(served.json()).toMatchObject({
      action: 'serve',
      environmentId: fixture.environmentId,
      canonicalHost: serving,
    });
  });

  it('redirects the www of a bare domain that is not the Main domain to that bare domain', async () => {
    const fixture = await newApp();
    await connectedDomain(fixture);
    const bare = bareName();
    await connectedDomain(fixture, bare, true);

    const www = await ensureApp(`www.${bare}`);

    expect(www.json()).toMatchObject({ action: 'redirect', canonicalHost: bare });
  });

  it('redirects the www of a bare Main domain to the bare domain', async () => {
    const fixture = await newApp();
    const bare = bareName();
    await connectedDomain(fixture, bare, true);

    const [apex, www] = [await ensureApp(bare), await ensureApp(`www.${bare}`)];

    expect(apex.json()).toMatchObject({ action: 'serve', canonicalHost: bare });
    expect(www.json()).toMatchObject({ action: 'redirect', canonicalHost: bare });
  });

  it('answers for the App that took a domain from another, while its certificate is still issuing', async () => {
    const first = await newApp();
    const second = await newApp();
    const hostname = subdomainName();
    await connectedDomain(first, hostname);
    pointAt(second, hostname);
    await add(second, hostname);

    const res = await ensureApp(hostname);

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ action: 'serve', environmentId: second.environmentId, canonicalHost: hostname });
  });
});

describe('the redirect to the Main domain', () => {
  it('is off for a new domain, which reaches the App on its own host', async () => {
    const fixture = await newApp();
    await connectedDomain(fixture);
    const [other, otherId] = await (async () => {
      const hostname = subdomainName();
      return [hostname, await connectedDomain(fixture, hostname)] as const;
    })();

    expect(await itemOf(fixture, otherId)).toMatchObject({ redirectsToMain: false });
    expect(middlewaresOf(otherId)).toEqual({ [other]: [MARKER] });
    expect(redirectOf(fixture)).toBeUndefined();
  });

  it('sends the domain on to the Main domain once turned on, and lets it serve again once turned off', async () => {
    const fixture = await newApp();
    const main = subdomainName();
    await connectedDomain(fixture, main);
    const other = subdomainName();
    const otherId = await connectedDomain(fixture, other);

    const on = await setRedirect(fixture, otherId, true);

    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ id: otherId, redirectsToMain: true });
    expect(middlewaresOf(otherId)).toEqual({ [other]: [redirectName(fixture)] });
    expect(redirectsTo(fixture, `https://${other}/a?b=1`)).toBe(`https://${main}/a?b=1`);

    const off = await setRedirect(fixture, otherId, false);

    expect(off.json()).toMatchObject({ redirectsToMain: false });
    expect(middlewaresOf(otherId)).toEqual({ [other]: [MARKER] });
    expect(redirectOf(fixture)).toBeUndefined();
  });

  it('refuses anything but true or false, and a member without can_manage_custom_domains', async () => {
    const fixture = await newApp();
    await connectedDomain(fixture);
    const otherId = await connectedDomain(fixture);
    const reader = await addMember(app, fixture.tenant);

    const malformed = await setRedirect(fixture, otherId, 'yes');
    const forbidden = await setRedirect(fixture, otherId, true, reader.headers);

    expect(malformed.statusCode).toBe(400);
    expect(forbidden.statusCode).toBe(403);
    expect(await itemOf(fixture, otherId)).toMatchObject({ redirectsToMain: false });
  });

  it('sends the www of a bare domain on to that bare domain, through a redirect that exists while a bare domain does', async () => {
    const fixture = await newApp();
    const hostname = bareName();
    const domainId = await connectedDomain(fixture, hostname, true);
    const withoutWww = kube.object('middlewares', withoutWwwName(fixture))?.spec.redirectRegex as {
      regex: string;
      replacement: string;
    };

    expect(middlewaresOf(domainId)).toEqual({ [hostname]: [MARKER], [`www.${hostname}`]: [withoutWwwName(fixture)] });
    expect(traefikRedirect(withoutWww, `https://www.${hostname}/a?b=1`)).toBe(`https://${hostname}/a?b=1`);

    expect((await remove(fixture, domainId)).statusCode).toBe(200);
    expect(kube.object('middlewares', withoutWwwName(fixture))).toBeUndefined();
  });
});

describe('a cluster write that fails', () => {
  it("keeps the domain with the App it is taken from until that App's route is deleted, then moves it on the next look", async () => {
    const first = await newApp();
    const second = await newApp();
    const hostname = subdomainName();
    const firstId = await connectedDomain(first, hostname);
    pointAt(second, hostname);
    kube.failNext('delete', 'ingressroutes');

    const secondId = await add(second, hostname);

    expect(await itemOf(second, secondId)).toMatchObject({ status: 'waiting' });
    expect(await itemOf(first, firstId)).toMatchObject({ status: 'connected', isMain: true });
    expect(objectsOf(firstId)).toMatchObject({ routes: 1, certificates: 1 });
    expect(objectsOf(secondId)).toEqual(NO_OBJECT);

    await refresh(second);

    expect(await itemOf(second, secondId)).toMatchObject({ status: 'issuing' });
    expect(await itemOf(first, firstId)).toBeUndefined();
    expect(objectsOf(firstId)).toEqual(NO_OBJECT);
  });

  it('leaves a domain issuing when its routes cannot be written as it connects, and connects it at the next look', async () => {
    const fixture = await newApp();
    const [first, other] = [subdomainName(), subdomainName()];
    const firstId = await issuingDomain(fixture, first);
    const otherId = await issuingDomain(fixture, other);
    await redirectToMain(fixture, otherId);
    kube.issue(`opsiforce-domain-${firstId}`);
    kube.failNext('create', 'middlewares');

    await refresh(fixture);

    expect(await itemOf(fixture, firstId)).toMatchObject({ status: 'issuing', isMain: false });
    expect(middlewaresOf(otherId)).toEqual({ [other]: [MARKER] });

    await refresh(fixture);

    expect(await itemOf(fixture, firstId)).toMatchObject({ status: 'connected', isMain: true });
    expect(middlewaresOf(otherId)).toEqual({ [other]: [redirectName(fixture)] });
  });

  it('keeps a domain whose objects cannot be deleted, so Remove can be pressed again, and the next rewrite restores what was deleted', async () => {
    const fixture = await newApp();
    const domainId = await connectedDomain(fixture);
    kube.failNext('delete', 'certificates');

    expect((await remove(fixture, domainId)).statusCode).not.toBe(200);
    expect(await itemOf(fixture, domainId)).toMatchObject({ status: 'connected' });
    expect(objectsOf(domainId)).toMatchObject({ routes: 0, certificates: 1 });

    await app.get(CustomDomainCluster).routeEnvironment(fixture.environmentId);

    expect(objectsOf(domainId)).toMatchObject({ routes: 1, certificates: 1 });

    expect((await remove(fixture, domainId)).statusCode).toBe(200);
    expect(await itemOf(fixture, domainId)).toBeUndefined();
    expect(objectsOf(domainId)).toEqual(NO_OBJECT);
  });

  it('touches none of the objects of a Main domain whose Remove fails while rerouting the others', async () => {
    const fixture = await newApp();
    const mainId = await connectedDomain(fixture);
    const otherId = await connectedDomain(fixture);
    await redirectToMain(fixture, otherId);
    kube.failNext('replace', 'ingressroutes');

    expect((await remove(fixture, mainId)).statusCode).not.toBe(200);

    expect(await itemOf(fixture, mainId)).toMatchObject({ status: 'connected', isMain: true });
    expect(objectsOf(mainId)).toEqual({ routes: 1, certificates: 1, secret: true });
  });

  it("orders a connected domain's certificate again when it has gone missing, at the next rewrite of its routes", async () => {
    const fixture = await newApp();
    const domainId = await connectedDomain(fixture);
    await kube.deleteNamespacedCustomObject({ plural: 'certificates', name: `opsiforce-domain-${domainId}` });

    await app.get(CustomDomainCluster).routeEnvironment(fixture.environmentId);

    expect(objectsOf(domainId)).toMatchObject({ certificates: 1 });
  });

  it('orders no certificate again for a domain Remove deleted after a refresh read it', async () => {
    const fixture = await newApp();
    const domainId = await issuingDomain(fixture);
    const cluster = app.get(CustomDomainCluster);
    const progress = vi.spyOn(cluster, 'certificateProgress').mockImplementationOnce(async () => {
      expect((await remove(fixture, domainId)).statusCode).toBe(200);
      return { state: 'missing' };
    });

    await refresh(fixture);
    progress.mockRestore();

    expect(objectsOf(domainId)).toEqual(NO_OBJECT);
  });

  it('keeps the redirect a route still names when turning it off fails at that route, and Check puts a lost redirect back', async () => {
    const fixture = await newApp();
    const main = subdomainName();
    await connectedDomain(fixture, main);
    const other = subdomainName();
    const otherId = await connectedDomain(fixture, other);
    await redirectToMain(fixture, otherId);
    kube.failNext('replace', 'ingressroutes');

    expect((await setRedirect(fixture, otherId, false)).statusCode).not.toBe(200);

    expect(await itemOf(fixture, otherId)).toMatchObject({ redirectsToMain: true });
    expect(middlewaresOf(otherId)).toEqual({ [other]: [redirectName(fixture)] });
    expect(redirectOf(fixture)).toBeDefined();

    await kube.deleteNamespacedCustomObject({ plural: 'middlewares', name: redirectName(fixture) });
    const checked = await app.inject({
      method: 'POST',
      url: `${fixture.url}/${otherId}/check`,
      headers: fixture.owner.headers,
    });

    expect(checked.statusCode, checked.body).toBe(201);
    expect(redirectsTo(fixture, `https://www.example-org.com/a`)).toBe(`https://${main}/a`);
  });
});
