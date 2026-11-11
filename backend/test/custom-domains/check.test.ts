import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CustomDomainModule } from '../../src/custom-domain/custom-domain.module';
import { PUBLIC_DNS } from '../../src/custom-domain/public-dns';
import { GatewayKeyService } from '../../src/gateway/gateway-key.service';
import { ProjectController } from '../../src/project/project.controller';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import {
  addMember,
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

const APPS = 'apps.check.test';
const MANAGE = 'can_manage_custom_domains';

@Module({ controllers: [ProjectController] })
class EditUrlRoutes {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
const dns = new FakePublicDns().zone('example-org.com');

beforeAll(async () => {
  harness = await createExternalServicesTestApp({
    env: { APPS_HOSTNAME: APPS, CUSTOM_DOMAINS_CLUSTER_ISSUER: 'test-issuer' },
    extraModules: [CustomDomainModule, EditUrlRoutes],
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
  url: string;
}

async function newApp(): Promise<AppFixture> {
  const tenant = await createTenant(app);
  const owner = await addMember(app, tenant, [MANAGE, 'can_edit_app_details']);
  const projectId = await createProject(app, tenant);
  const key = await app.get(GatewayKeyService).createKey(projectId, projectId, tenant.tenantId);
  const reported = await app.inject({
    method: 'POST',
    url: '/api/gateway/app/state',
    headers: { authorization: `Bearer ${key}` },
    payload: { live: true, name: 'Equipment Monitor' },
  });
  expect(reported.statusCode, reported.body).toBe(201);
  return { tenant, owner, projectId, url: `/api/projects/${projectId}/environments/${projectId}/domains` };
}

async function editUrl(fixture: AppFixture, appSlug: string): Promise<void> {
  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${fixture.projectId}/app`,
    headers: fixture.owner.headers,
    payload: { environmentId: fixture.projectId, appSlug },
  });
  expect(edited.statusCode, edited.body).toBe(200);
}

const LOAD_BALANCER = '203.0.113.10';

function subdomainName(): string {
  return `shop-${randomUUID().slice(0, 8)}.example-org.com`;
}

function bareName(): string {
  const name = `example-org-${randomUUID().slice(0, 8)}.com`;
  dns.zone(name);
  return name;
}

async function list(fixture: AppFixture) {
  const listed = await app.inject({ method: 'GET', url: fixture.url, headers: fixture.owner.headers });
  expect(listed.statusCode, listed.body).toBe(200);
  return listed.json();
}

function addDomain(fixture: AppFixture, hostname: string) {
  return app.inject({ method: 'POST', url: fixture.url, headers: fixture.owner.headers, payload: { hostname } });
}

async function add(fixture: AppFixture, hostname: string): Promise<string> {
  const added = await addDomain(fixture, hostname);
  expect(added.statusCode, added.body).toBe(201);
  return added.json().id;
}

function check(fixture: AppFixture, domainId: string, headers = fixture.owner.headers) {
  return app.inject({ method: 'POST', url: `${fixture.url}/${domainId}/check`, headers });
}

describe('the first Check', () => {
  it('runs when the domain is added, so a record that is already right moves it on at once', async () => {
    const fixture = await newApp();
    const { defaultAddress } = await list(fixture);
    const hostname = subdomainName();
    dns.cname(hostname, defaultAddress);

    const added = await addDomain(fixture, hostname);

    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({
      status: 'issuing',
      dnsAnswer: `CNAME → ${defaultAddress}`,
      checkedAt: expect.any(String),
    });
  });
});

describe('Check on a subdomain', () => {
  it('passes when its CNAME names the Default address, and moves the domain on to issuing', async () => {
    const fixture = await newApp();
    const { defaultAddress } = await list(fixture);
    const hostname = subdomainName();
    const domainId = await add(fixture, hostname);
    dns.cname(hostname, defaultAddress);

    const checked = await check(fixture, domainId);

    expect(checked.statusCode, checked.body).toBe(201);
    expect(checked.json()).toMatchObject({
      id: domainId,
      status: 'issuing',
      dnsAnswer: `CNAME → ${defaultAddress}`,
      checkedAt: expect.any(String),
    });
    expect((await list(fixture)).items).toMatchObject([{ id: domainId, status: 'issuing' }]);
  });

  it('passes when its CNAME names a Default address Edit URL has since replaced', async () => {
    const fixture = await newApp();
    const { defaultAddress: earlierAddress } = await list(fixture);
    await editUrl(fixture, 'warehouse');
    const { defaultAddress } = await list(fixture);
    const hostname = subdomainName();
    const domainId = await add(fixture, hostname);
    dns.cname(hostname, earlierAddress);

    const checked = await check(fixture, domainId);

    expect(defaultAddress).not.toBe(earlierAddress);
    expect(checked.json()).toMatchObject({ status: 'issuing', dnsAnswer: `CNAME → ${earlierAddress}` });
  });

  it('stays waiting when its CNAME names another App, and stores what DNS answered', async () => {
    const fixture = await newApp();
    const { defaultAddress: anotherAppsAddress } = await list(await newApp());
    const hostname = subdomainName();
    const domainId = await add(fixture, hostname);
    dns.cname(hostname, anotherAppsAddress);

    const checked = await check(fixture, domainId);

    expect(checked.statusCode, checked.body).toBe(201);
    expect(checked.json()).toMatchObject({
      status: 'waiting',
      dnsAnswer: `CNAME → ${anotherAppsAddress}`,
      checkedAt: expect.any(String),
    });
  });

  it("stays waiting when its CNAME names the App's preview address, which is not one of its Default addresses", async () => {
    const fixture = await newApp();
    const preview = `${fixture.projectId}.preview.${APPS}`;
    const hostname = subdomainName();
    const domainId = await add(fixture, hostname);
    dns.cname(hostname, preview);

    const checked = await check(fixture, domainId);

    expect(checked.statusCode, checked.body).toBe(201);
    expect(checked.json()).toMatchObject({ status: 'waiting', dnsAnswer: `CNAME → ${preview}` });
  });

  it('stays waiting with no answer while the name has no record', async () => {
    const fixture = await newApp();
    const domainId = await add(fixture, subdomainName());

    const checked = await check(fixture, domainId);

    expect(checked.statusCode, checked.body).toBe(201);
    expect(checked.json()).toMatchObject({ status: 'waiting', dnsAnswer: null, checkedAt: expect.any(String) });
  });

  it('stays waiting and shows the addresses when the name has A and AAAA records instead', async () => {
    const fixture = await newApp();
    const hostname = subdomainName();
    const domainId = await add(fixture, hostname);
    dns.address(hostname, '203.0.113.7', '203.0.113.8', '2001:db8::7');

    const checked = await check(fixture, domainId);

    expect(checked.json()).toMatchObject({
      status: 'waiting',
      dnsAnswer: 'A → 203.0.113.7, 203.0.113.8; AAAA → 2001:db8::7',
    });
  });
});

describe('Check on a bare domain', () => {
  async function bareDomainOf(fixture: AppFixture) {
    const { defaultAddress } = await list(fixture);
    dns.address(defaultAddress, LOAD_BALANCER);
    const hostname = bareName();
    return { hostname, defaultAddress, domainId: await add(fixture, hostname) };
  }

  it('passes when its www names the Default address and its apex answers with the same address', async () => {
    const fixture = await newApp();
    const { hostname, defaultAddress, domainId } = await bareDomainOf(fixture);
    dns.address(hostname, LOAD_BALANCER).cname(`www.${hostname}`, defaultAddress);

    const checked = await check(fixture, domainId);

    expect(checked.json()).toMatchObject({
      bare: true,
      status: 'issuing',
      dnsAnswer: `A → ${LOAD_BALANCER}; www.${hostname} CNAME → ${defaultAddress}`,
    });
  });

  it('stays waiting while its apex answers with an address elsewhere', async () => {
    const fixture = await newApp();
    const { hostname, defaultAddress, domainId } = await bareDomainOf(fixture);
    dns.address(hostname, '198.51.100.4').cname(`www.${hostname}`, defaultAddress);

    const checked = await check(fixture, domainId);

    expect(checked.json()).toMatchObject({
      status: 'waiting',
      dnsAnswer: `A → 198.51.100.4; www.${hostname} CNAME → ${defaultAddress}`,
    });
  });

  it('stays waiting while its www has no record, even with the apex right', async () => {
    const fixture = await newApp();
    const { hostname, domainId } = await bareDomainOf(fixture);
    dns.address(hostname, LOAD_BALANCER);

    const checked = await check(fixture, domainId);

    expect(checked.json()).toMatchObject({ status: 'waiting', dnsAnswer: `A → ${LOAD_BALANCER}` });
  });
});

describe('who may Check, and when DNS cannot be reached', () => {
  it('refuses a member without can_manage_custom_domains and stores nothing', async () => {
    const fixture = await newApp();
    const { defaultAddress } = await list(fixture);
    const hostname = subdomainName();
    const domainId = await add(fixture, hostname);
    dns.cname(hostname, defaultAddress);
    const reader = await addMember(app, fixture.tenant);

    const checked = await check(fixture, domainId, reader.headers);

    expect(checked.statusCode).toBe(403);
    expect((await list(fixture)).items).toMatchObject([{ status: 'waiting', dnsAnswer: null }]);
  });

  it("answers 404 for a domain of another of the Organization's Apps", async () => {
    const fixture = await newApp();
    const other = await newApp();
    const domainId = await add(other, subdomainName());

    const checked = await check(fixture, domainId);

    expect(checked.statusCode).toBe(404);
  });

  it('answers 503 and stores nothing while public DNS cannot be reached', async () => {
    const fixture = await newApp();
    const domainId = await add(fixture, subdomainName());
    const [before] = (await list(fixture)).items;
    dns.goUnreachable();
    try {
      const checked = await check(fixture, domainId);

      expect(checked.statusCode).toBe(503);
      expect(checked.json().message).toBe("Couldn't reach DNS. Try again in a moment.");
    } finally {
      dns.comeBack();
    }
    expect((await list(fixture)).items).toEqual([before]);
  });
});

describe('refreshing the list', () => {
  function refresh(fixture: AppFixture, headers = fixture.owner.headers) {
    return app.inject({ method: 'POST', url: `${fixture.url}/refresh`, headers });
  }

  it('checks every domain waiting for DNS and moves the one whose record is right on, answering the list', async () => {
    const fixture = await newApp();
    const { defaultAddress } = await list(fixture);
    const [rightName, wrongName] = [subdomainName(), subdomainName()];
    const right = await add(fixture, rightName);
    const wrong = await add(fixture, wrongName);
    dns.cname(rightName, defaultAddress).cname(wrongName, 'example-org.base44.app');

    const refreshed = await refresh(fixture);

    expect(refreshed.statusCode, refreshed.body).toBe(201);
    expect(refreshed.json()).toMatchObject({
      defaultAddress,
      items: [
        { id: right, status: 'issuing', dnsAnswer: `CNAME → ${defaultAddress}` },
        { id: wrong, status: 'waiting', dnsAnswer: 'CNAME → example-org.base44.app' },
      ],
    });
  });

  it('never checks the DNS of a connected domain again', async () => {
    const fixture = await newApp();
    const { defaultAddress } = await list(fixture);
    const hostname = subdomainName();
    dns.cname(hostname, defaultAddress);
    const domainId = await add(fixture, hostname);
    kube.issue(`opsiforce-domain-${domainId}`);
    const connected = (await refresh(fixture)).json().items[0];
    dns.cname(hostname, 'example-org.base44.app');

    const refreshed = await refresh(fixture);

    expect(connected).toMatchObject({ status: 'connected' });
    expect(refreshed.json().items).toMatchObject([
      { id: domainId, status: 'connected', dnsAnswer: connected.dnsAnswer, checkedAt: connected.checkedAt },
    ]);
  });

  it('answers the list unchanged while public DNS cannot be reached', async () => {
    const fixture = await newApp();
    await add(fixture, subdomainName());
    const before = await list(fixture);
    dns.goUnreachable();
    try {
      const refreshed = await refresh(fixture);

      expect(refreshed.statusCode, refreshed.body).toBe(201);
      expect(refreshed.json()).toEqual(before);
    } finally {
      dns.comeBack();
    }
  });

  it('is refused to a member without can_manage_custom_domains, who checks nothing and still gets the list', async () => {
    const fixture = await newApp();
    const { defaultAddress } = await list(fixture);
    const hostname = subdomainName();
    await add(fixture, hostname);
    dns.cname(hostname, defaultAddress);
    const reader = await addMember(app, fixture.tenant);

    const refreshed = await refresh(fixture, reader.headers);
    const listed = await app.inject({ method: 'GET', url: fixture.url, headers: reader.headers });

    expect(refreshed.statusCode).toBe(403);
    expect(listed.json().items).toMatchObject([{ status: 'waiting', dnsAnswer: null }]);
  });
});
