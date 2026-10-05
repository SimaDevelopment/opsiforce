import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectVirtualKeys, projects } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { startFakeVendorApi, type FakeVendorApi } from './support/fake-vendor-api';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };

interface TenantRow {
  name: string;
  baseFormat: string | null;
  enabled: boolean;
  weight: number;
  status: string;
}

interface SeededTenant {
  tenant: TenantFixture;
  admin: MemberFixture;
  projectId: string;
}

async function chatKeyIdOf(seeded: SeededTenant): Promise<string> {
  const [key] = await db
    .select({ id: projectVirtualKeys.bifrostKeyId })
    .from(projectVirtualKeys)
    .innerJoin(projects, eq(projects.id, projectVirtualKeys.projectId))
    .where(and(eq(projects.id, seeded.projectId), eq(projectVirtualKeys.keyType, 'chat')));
  return key.id;
}

describe('a global Built-in model provider', () => {
  let bifrost: FakeBifrost;
  let vendor: FakeVendorApi;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;
  let platformAdmin: MemberFixture;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    vendor = await startFakeVendorApi();
    harness = await createPublicApiTestApp(
      {
        ...bifrost.env,
        MODEL_PROVIDER_OFFICIAL_API_URLS: JSON.stringify({ openai: vendor.baseUrl, anthropic: vendor.baseUrl }),
      },
      [ModelProvidersModule],
      [BifrostService]
    );
    app = harness.app;
    agentId = await createAgent();
    platformAdmin = await addMember(app, await createTenant(app), [Perms.managePlatformModelProviders]);
  });

  afterEach(() => {
    bifrost.becomeReachable();
    bifrost.acceptProviderConfigWrites();
    bifrost.deleteProvidersOnDelete();
    bifrost.setProviders(HELM_PROVIDERS);
    vendor.replyWith('models');
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await vendor.close();
  });

  async function holdEveryChatKey(): Promise<void> {
    const keys = await db
      .select({ id: projectVirtualKeys.bifrostKeyId })
      .from(projectVirtualKeys)
      .where(eq(projectVirtualKeys.keyType, 'chat'));
    bifrost.holdVirtualKeys(keys.map((key) => key.id));
  }

  async function seededTenant(): Promise<SeededTenant> {
    const tenant = await createTenant(app);
    const admin = await addMember(app, tenant, [Perms.manageTenantModelProviders]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: (await addMember(app, tenant)).headers,
      payload: { title: 'Routed', agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { tenant, admin, projectId: res.json<{ id: string }>().id };
  }

  async function global(name: string): Promise<string> {
    await holdEveryChatKey();
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform-model-providers',
      headers: platformAdmin.headers,
      payload: { baseFormat: 'openai', kind: 'official-api-key', name, key: `sk-${name}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return `opsiforce-${name}`;
  }

  async function rowsOf(seeded: SeededTenant): Promise<TenantRow[]> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: seeded.admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: TenantRow[] }>().providers;
  }

  async function switchOn(seeded: SeededTenant, name: string, weight: number) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-providers/formats/openai',
      headers: seeded.admin.headers,
      payload: { providers: [{ name, enabled: true, weight }] },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  function chatProvidersOf(seeded: SeededTenant): string[] {
    return bifrost.chatKeyOf(seeded.projectId).provider_configs.map((config) => config.provider);
  }

  function remove(name: string) {
    return app.inject({
      method: 'DELETE',
      url: `/api/platform-model-providers/${name}`,
      headers: platformAdmin.headers,
    });
  }

  it('appears switched off at weight 1 in every existing Organization, and leaves their chat keys as they are', async () => {
    const first = await seededTenant();
    const second = await seededTenant();
    const keyIds = await Promise.all([first, second].map(chatKeyIdOf));
    const writesBefore = keyIds.map((keyId) => bifrost.providerConfigWritesTo(keyId).length);

    const name = await global('everywhere');

    for (const seeded of [first, second]) {
      expect(await rowsOf(seeded)).toContainEqual({
        name,
        baseFormat: 'openai',
        enabled: false,
        weight: 1,
        status: 'working',
      });
      expect(chatProvidersOf(seeded)).not.toContain(name);
    }
    keyIds.forEach((keyId, index) => {
      expect(bifrost.providerConfigWritesTo(keyId)).toHaveLength(writesBefore[index]);
    });
    expect((await remove(name)).statusCode).toBe(200);
  });

  it('reaches an Organization created afterwards switched off, while the fixed built-ins arrive switched on', async () => {
    const name = await global('later');

    const later = await seededTenant();

    const rows = await rowsOf(later);
    expect(rows).toContainEqual({ name, baseFormat: 'openai', enabled: false, weight: 1, status: 'working' });
    expect(rows.filter((row) => HELM_PROVIDERS.includes(row.name)).map((row) => [row.name, row.enabled])).toEqual([
      ['anthropic', true],
      ['custom-openai-1', true],
      ['openai', true],
    ]);
    expect(chatProvidersOf(later)).not.toContain(name);
    expect((await remove(name)).statusCode).toBe(200);
  });

  it('switched on in one Organization reaches only that Organization’s chat keys', async () => {
    const switched = await seededTenant();
    const other = await seededTenant();
    const name = await global('one-seeded');

    await switchOn(switched, name, 4);

    expect(bifrost.chatKeyOf(switched.projectId).provider_configs).toContainEqual({
      provider: name,
      weight: 4,
      ...CATALOG_WIDE,
    });
    expect(chatProvidersOf(other)).not.toContain(name);
    expect(await rowsOf(other)).toContainEqual({
      name,
      baseFormat: 'openai',
      enabled: false,
      weight: 1,
      status: 'working',
    });
    expect((await remove(name)).statusCode).toBe(200);
  });

  it('is removed from every Organization when deleted, confirming the gateway delete with a GET', async () => {
    const first = await seededTenant();
    const second = await seededTenant();
    const name = await global('deleted');
    await switchOn(first, name, 2);
    const before = bifrost.requests.length;

    const res = await remove(name);

    expect(res.statusCode, res.body).toBe(200);
    for (const seeded of [first, second]) {
      expect((await rowsOf(seeded)).map((row) => row.name)).not.toContain(name);
      expect(chatProvidersOf(seeded)).not.toContain(name);
    }
    expect(
      bifrost.requests
        .slice(before)
        .filter((request) => request.path === `/api/providers/${name}`)
        .map((request) => request.method)
    ).toEqual(['DELETE', 'GET']);
  });

  it('is never chosen per Organization: the offer routes are gone', async () => {
    const seeded = await seededTenant();
    const name = await global('no-offers');

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/platform-model-providers/offers', headers: platformAdmin.headers }),
      app.inject({
        method: 'PUT',
        url: `/api/platform-model-providers/${name}/offers`,
        headers: platformAdmin.headers,
        payload: { tenantIds: [seeded.tenant.tenantId] },
      }),
    ]);

    expect(responses.map((res) => res.statusCode)).toEqual([404, 404]);
    expect((await remove(name)).statusCode).toBe(200);
  });
});
