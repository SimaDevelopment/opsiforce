import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { environments } from '../../db/schema';
import { appCanonicalHost } from '../../src/common/app-host';
import { CustomDomainModule } from '../../src/custom-domain/custom-domain.module';
import { PUBLIC_DNS } from '../../src/custom-domain/public-dns';
import { PRODUCTION_ENVIRONMENT_SLUG } from '../../src/environment/environment.types';
import { LimitService } from '../../src/limit/limit.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { ProjectService } from '../../src/project/project.service';
import { PublishService } from '../../src/publish/publish.service';
import { TenantController } from '../../src/tenant/tenant.controller';
import { createCustomService, ensureExternalServiceBuilder } from '../support/custom-services';
import { createExternalServicesTestApp, type ExternalServicesTestApp } from '../support/external-services-app';
import {
  addMember,
  createAgent,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { FakePublicDns } from './support/fake-public-dns';

vi.mock('../../src/common/k8s-client', async () => {
  const { fakeKube } = await import('./support/fake-kube.js');
  return { loadKubeConfig: () => ({ makeApiClient: () => fakeKube }) };
});

const APPS = 'apps.domains.test';
const MANAGE = 'can_manage_custom_domains';

@Module({ controllers: [TenantController] })
class TenantConfigModule {}

let harness: ExternalServicesTestApp;
let app: NestFastifyApplication;
const dns = new FakePublicDns()
  .zone('example-org.com')
  .zone('example-org.co.uk')
  .zone('eu.example-org.com')
  .zone('base44.app')
  .cname('www.example-org.com', 'example-org.com')
  .cname('store.example-org.com', 'example-org.base44.app');

beforeAll(async () => {
  harness = await createExternalServicesTestApp({
    env: {
      APPS_HOSTNAME: APPS,
      CUSTOM_DOMAINS_CLUSTER_ISSUER: 'test-issuer',
      CUSTOM_DOMAINS_REFUSED: 'opsima.com, simaanalytics.co',
    },
    extraModules: [CustomDomainModule, TenantConfigModule],
    providers: [{ provide: PUBLIC_DNS, useValue: dns }],
  });
  app = harness.app;
});

afterAll(async () => {
  await harness.close();
});

interface DomainsFixture {
  tenant: TenantFixture;
  owner: MemberFixture;
  projectId: string;
  environmentId: string;
  url: string;
}

async function newApp(existing?: TenantFixture): Promise<DomainsFixture> {
  const tenant = existing ?? (await createTenant(app));
  const owner = await addMember(app, tenant, [MANAGE]);
  const projectId = await createProject(app, tenant);
  return {
    tenant,
    owner,
    projectId,
    environmentId: projectId,
    url: `/api/projects/${projectId}/environments/${projectId}/domains`,
  };
}

function anotherAppOf(fixture: DomainsFixture): Promise<DomainsFixture> {
  return newApp(fixture.tenant);
}

function environmentOf(fixture: DomainsFixture, projectId: string, environmentId: string): DomainsFixture {
  return {
    ...fixture,
    projectId,
    environmentId,
    url: `/api/projects/${projectId}/environments/${environmentId}/domains`,
  };
}

async function productionOf(fixture: DomainsFixture): Promise<string> {
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.tenantId, fixture.tenant.tenantId), eq(environments.slug, PRODUCTION_ENVIRONMENT_SLUG)));
  return production.id;
}

async function defaultAddressOf(environmentId: string): Promise<string> {
  return appCanonicalHost(await app.get(ProjectEnvironmentService).findById(environmentId), APPS);
}

function add(fixture: DomainsFixture, hostname: string, headers = fixture.owner.headers) {
  return app.inject({ method: 'POST', url: fixture.url, headers, payload: { hostname } });
}

function remove(fixture: DomainsFixture, domainId: string, headers = fixture.owner.headers) {
  return app.inject({ method: 'DELETE', url: `${fixture.url}/${domainId}`, headers });
}

function list(fixture: DomainsFixture, headers = fixture.owner.headers) {
  return app.inject({ method: 'GET', url: fixture.url, headers });
}

describe('adding a Custom domain', () => {
  it('lists a subdomain as waiting for DNS, with the one CNAME to add', async () => {
    const fixture = await newApp();

    const added = await add(fixture, 'shop.example-org.com');

    expect(added.statusCode, added.body).toBe(201);
    const listed = await list(fixture);
    expect(listed.statusCode, listed.body).toBe(200);
    const defaultAddress = await defaultAddressOf(fixture.environmentId);
    expect(listed.json()).toMatchObject({
      defaultAddress,
      items: [
        {
          id: added.json().id,
          hostname: 'shop.example-org.com',
          displayHostname: 'shop.example-org.com',
          bare: false,
          status: 'waiting',
          isMain: false,
          dnsAnswer: null,
          checkedAt: expect.any(String),
          records: [{ type: 'CNAME', name: 'shop.example-org.com', host: 'shop', value: defaultAddress }],
        },
      ],
      usage: { used: 1, limit: null },
    });
  });

  it('gives a bare domain an ALIAS and a CNAME for its www', async () => {
    const fixture = await newApp();

    const added = await add(fixture, 'example-org.com');

    expect(added.statusCode, added.body).toBe(201);
    const defaultAddress = await defaultAddressOf(fixture.environmentId);
    expect(added.json()).toMatchObject({
      hostname: 'example-org.com',
      bare: true,
      status: 'waiting',
      records: [
        { type: 'ALIAS', name: 'example-org.com', host: '@', value: defaultAddress },
        { type: 'CNAME', name: 'www.example-org.com', host: 'www', value: defaultAddress },
      ],
    });
  });

  it.each([
    ['a domain under a two-label suffix', 'example-org.co.uk', true],
    ['a subdomain run as its own zone', 'eu.example-org.com', true],
    ['a name whose CNAME leads to its zone start', 'www.example-org.com', false],
    ['a name still pointing elsewhere', 'store.example-org.com', false],
  ])('decides bare or subdomain by where DNS starts the zone: %s', async (_case, hostname, bare) => {
    const added = await add(await newApp(), hostname);

    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ hostname, bare });
  });

  it.each([
    ['a subdomain under a two-label suffix', 'shop.example-org.co.uk', ['shop']],
    ['a domain under a two-label suffix', 'example-org.co.uk', ['@', 'www']],
    ['a subdomain of a subdomain run as its own zone', 'shop.eu.example-org.com', ['shop']],
    ['a name two labels below its zone start', 'shop.team.example-org.com', ['shop.team']],
  ])('names each record by its host in the zone, as DNS providers ask: %s', async (_case, hostname, hosts) => {
    const added = await add(await newApp(), hostname);

    expect(added.statusCode, added.body).toBe(201);
    expect(added.json().records.map((record: { host: string }) => record.host)).toEqual(hosts);
  });

  it('refuses a domain public DNS has never heard of', async () => {
    const fixture = await newApp();

    const added = await add(fixture, 'shop.nowhere-example-org.com');

    expect(added.statusCode).toBe(400);
    expect(added.json().message).toBe(
      "We can't find this domain in DNS yet. Check the spelling, or add it once its DNS is set up."
    );
    expect((await list(fixture)).json().items).toEqual([]);
  });

  it('answers 503 and adds nothing while public DNS cannot be reached', async () => {
    const fixture = await newApp();
    dns.goUnreachable();
    try {
      const added = await add(fixture, 'shop.example-org.com');

      expect(added.statusCode).toBe(503);
      expect(added.json().message).toBe("Couldn't reach DNS. Try again in a moment.");
    } finally {
      dns.comeBack();
    }
    expect((await list(fixture)).json().items).toEqual([]);
  });
});

describe('what an owner may type', () => {
  it('drops the scheme, path, port and trailing dot and lowercases the name', async () => {
    const added = await add(await newApp(), '  HTTPS://Shop.Example-Org.com.:443/catalog?page=2 ');

    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ hostname: 'shop.example-org.com', displayHostname: 'shop.example-org.com' });
  });

  it('stores an international name as punycode and shows it back in Unicode', async () => {
    const added = await add(await newApp(), 'Bücher.example-org.com');

    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({
      hostname: 'xn--bcher-kva.example-org.com',
      displayHostname: 'bücher.example-org.com',
      records: [{ type: 'CNAME', name: 'xn--bcher-kva.example-org.com' }],
    });
  });

  it.each([
    ['203.0.113.7', 'Enter a domain name, not an IP address.'],
    ['https://[2001:db8::1]/', 'Enter a domain name, not an IP address.'],
    ['0x7f.1', 'Enter a domain name, not an IP address.'],
    ['localhost', 'Enter a full domain, like app.example-org.com.'],
    ['shop', 'Enter a full domain, like app.example-org.com.'],
    ['', 'Enter a full domain, like app.example-org.com.'],
    ['*.example-org.com', "Wildcard domains aren't supported. Add each address you need."],
    ['shop_1.example-org.com', 'Use letters, digits, dots and dashes only.'],
    ['shop!.example-org.com', 'Use letters, digits, dots and dashes only.'],
    ['-shop.example-org.com', 'Use letters, digits, dots and dashes only.'],
    ['opsima.com', "opsima.com belongs to the platform and can't be connected."],
    ['shop.apps.opsima.com', "opsima.com belongs to the platform and can't be connected."],
    ['eu.SimaAnalytics.co', "simaanalytics.co belongs to the platform and can't be connected."],
  ])('refuses %j with its reason', async (hostname, message) => {
    const fixture = await newApp();

    const added = await add(fixture, hostname);

    expect(added.statusCode, added.body).toBe(400);
    expect(added.json().message).toBe(message);
    expect((await list(fixture)).json().items).toEqual([]);
  });

  it('refuses a domain this App already has, however it is typed', async () => {
    const fixture = await newApp();
    await add(fixture, 'shop.example-org.com');

    const again = await add(fixture, 'https://SHOP.example-org.com/');

    expect(again.statusCode).toBe(400);
    expect(again.json().message).toBe('This App already has this domain.');
  });

  it('refuses the www of a bare domain the App already has', async () => {
    const fixture = await newApp();
    await add(fixture, 'example-org.com');

    const www = await add(fixture, 'www.example-org.com');

    expect(www.statusCode).toBe(400);
    expect(www.json().message).toBe('www.example-org.com comes with example-org.com, which is already added.');
  });

  it('refuses a bare domain whose www the App already has on its own', async () => {
    const fixture = await newApp();
    await add(fixture, 'www.example-org.com');

    const bare = await add(fixture, 'example-org.com');

    expect(bare.statusCode).toBe(400);
    expect(bare.json().message).toBe(
      'www.example-org.com is already added on its own. Remove it first, then add example-org.com, which brings www along.'
    );
    expect((await list(fixture)).json().items).toMatchObject([{ hostname: 'www.example-org.com' }]);
  });

  it('lets another App add a domain this App is still waiting on', async () => {
    await add(await newApp(), 'shop.example-org.com');

    const added = await add(await newApp(), 'shop.example-org.com');

    expect(added.statusCode, added.body).toBe(201);
  });
});

describe('the custom_domains Limit', () => {
  it("counts every domain of the Organization's Apps, a bare domain once, and refuses the one past it", async () => {
    const first = await newApp();
    const second = await anotherAppOf(first);
    await new LimitService().setTenantLimit(first.tenant.tenantId, 'custom_domains', 2);
    await add(first, 'example-org.com');
    await add(second, 'shop.example-org.com');

    const refused = await add(second, 'store.example-org.com');

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'limit_reached',
      message: 'This organization has reached its limit of 2 custom domains.',
    });
    expect((await list(first)).json().usage).toEqual({ used: 2, limit: 2 });
    expect((await list(second)).json().items.map((item: { hostname: string }) => item.hostname)).toEqual([
      'shop.example-org.com',
    ]);
  });
});

describe('removing a Custom domain', () => {
  it('takes it off the App and frees its place under the Limit', async () => {
    const fixture = await newApp();
    const shop = (await add(fixture, 'shop.example-org.com')).json();
    await add(fixture, 'store.example-org.com');

    const removed = await remove(fixture, shop.id);

    expect(removed.statusCode, removed.body).toBe(200);
    const listed = (await list(fixture)).json();
    expect(listed.items.map((item: { hostname: string }) => item.hostname)).toEqual(['store.example-org.com']);
    expect(listed.usage.used).toBe(1);
  });

  it("answers 404 for a domain of another of the Organization's Apps", async () => {
    const fixture = await newApp();
    const other = await anotherAppOf(fixture);
    const shop = (await add(other, 'shop.example-org.com')).json();

    const removed = await remove(fixture, shop.id);

    expect(removed.statusCode).toBe(404);
    expect((await list(other)).json().items).toHaveLength(1);
  });
});

describe('can_manage_custom_domains', () => {
  it('lets a member without it see the domains but not add or remove one', async () => {
    const fixture = await newApp();
    const shop = (await add(fixture, 'shop.example-org.com')).json();
    const reader = await addMember(app, fixture.tenant);

    const listed = await list(fixture, reader.headers);
    const added = await add(fixture, 'store.example-org.com', reader.headers);
    const removed = await remove(fixture, shop.id, reader.headers);

    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([shop.id]);
    expect(added.statusCode).toBe(403);
    expect(removed.statusCode).toBe(403);
    expect((await list(fixture)).json().items.map((item: { id: string }) => item.id)).toEqual([shop.id]);
  });
});

describe('a Project that serves an External Service', () => {
  it('has no public App, so every domain route answers 404', async () => {
    await ensureExternalServiceBuilder();
    const tenant = await createTenant(app);
    const admin = await addMember(app, tenant, [MANAGE, 'can_manage_tenant_external_services']);
    const service = await createCustomService(app, { ...admin, tenant }, 'Boards', 'boards');
    const url = `/api/projects/${service.builderChatId}/environments/${service.builderChatId}/domains`;

    const responses = await Promise.all([
      app.inject({ method: 'GET', url, headers: admin.headers }),
      app.inject({ method: 'POST', url, headers: admin.headers, payload: { hostname: 'boards.example-org.com' } }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404]);
  });
});

describe('a deployment that names no certificate issuer', () => {
  let offHarness: ExternalServicesTestApp;
  let offApp: NestFastifyApplication;

  beforeAll(async () => {
    offHarness = await createExternalServicesTestApp({
      env: { APPS_HOSTNAME: APPS, CUSTOM_DOMAINS_CLUSTER_ISSUER: '' },
      extraModules: [CustomDomainModule, TenantConfigModule],
      providers: [{ provide: PUBLIC_DNS, useValue: dns }],
    });
    offApp = offHarness.app;
  });

  afterAll(async () => {
    await offHarness.close();
  });

  it('tells the UI custom domains are off, while a deployment with one says they are on', async () => {
    const fixture = await newApp();

    const off = await offApp.inject({ method: 'GET', url: '/api/tenants/config', headers: fixture.owner.headers });
    const on = await app.inject({ method: 'GET', url: '/api/tenants/config', headers: fixture.owner.headers });

    expect(off.json()).toMatchObject({ customDomainsEnabled: false });
    expect(on.json()).toMatchObject({ customDomainsEnabled: true });
  });

  it('answers 404 on every domain route', async () => {
    const fixture = await newApp();
    const shop = (await add(fixture, 'shop.example-org.com')).json();
    const headers = fixture.owner.headers;

    const responses = await Promise.all([
      offApp.inject({ method: 'GET', url: fixture.url, headers }),
      offApp.inject({ method: 'POST', url: fixture.url, headers, payload: { hostname: 'store.example-org.com' } }),
      offApp.inject({ method: 'POST', url: `${fixture.url}/refresh`, headers }),
      offApp.inject({ method: 'POST', url: `${fixture.url}/${shop.id}/check`, headers }),
      offApp.inject({ method: 'DELETE', url: `${fixture.url}/${shop.id}`, headers }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404]);
    expect((await list(fixture)).json().items).toHaveLength(1);
  });
});

describe('copies of an App', () => {
  async function appWithADomain(): Promise<DomainsFixture> {
    const fixture = await newApp();
    expect((await add(fixture, 'shop.example-org.com')).statusCode).toBe(201);
    return fixture;
  }

  it('leave its domains behind on Duplicate', async () => {
    const source = await appWithADomain();

    const copy = await app.get(ProjectService).duplicate(source.projectId, source.tenant.tenantId, undefined, null);

    expect((await list(environmentOf(source, copy.id, copy.id))).json().items).toEqual([]);
  });

  it('leave its domains behind on Publish', async () => {
    const source = await appWithADomain();

    const job = await app
      .get(PublishService)
      .publish(source.projectId, source.tenant.tenantId, { environmentId: await productionOf(source) });

    const published = await list(environmentOf(source, source.projectId, job.projectEnvironmentId));
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().items).toEqual([]);
  });

  it('start an imported App with none', async () => {
    const source = await newApp();

    const imported = await app.get(ProjectService).createImportedProject({
      tenantId: source.tenant.tenantId,
      workspaceId: null,
      folderId: null,
      title: 'Imported',
      timezone: 'UTC',
      agentId: await createAgent(),
      importedAgent: null,
      description: null,
      settings: null,
      resources: null,
      appDetails: { name: 'Shop', description: null },
      schedules: [],
      createdBy: null,
    });

    expect((await list(environmentOf(source, imported.id, imported.id))).json().items).toEqual([]);
  });
});
