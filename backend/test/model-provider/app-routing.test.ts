import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';
import { startFakeVendorApi, type FakeVendorApi } from './support/fake-vendor-api';
import { BASE_FORMATS } from '../../src/model-provider/base-formats';
import { servedModelsOf } from '../../src/model-provider/bifrost-provider-shape';

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const OPENAI_FAMILY = { allowed_models: servedModelsOf(BASE_FORMATS.openai), key_ids: ['*'] };

interface SeededTenant {
  tenant: TenantFixture;
  admin: MemberFixture;
  projectId: string;
}

interface Row {
  name: string;
  chatEnabled: boolean;
  chatWeight: number;
  backendEnabled: boolean;
  backendWeight: number;
}

describe('App routing of a Project’s backend key', () => {
  let bifrost: FakeBifrost;
  let vendor: FakeVendorApi;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;

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
  });

  afterEach(() => {
    bifrost.becomeReachable();
    bifrost.setProviders(HELM_PROVIDERS);
    vendor.replyWith('models');
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await vendor.close();
  });

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

  function saveFormat(seeded: SeededTenant, format: string, providers: Record<string, unknown>[]) {
    return app.inject({
      method: 'PUT',
      url: `/api/model-providers/formats/${format}`,
      headers: seeded.admin.headers,
      payload: { providers },
    });
  }

  async function rowsOf(seeded: SeededTenant): Promise<Row[]> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: seeded.admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: Row[] }>().providers;
  }

  function backendProvidersOf(seeded: SeededTenant) {
    return bifrost.backendKeyOf(seeded.projectId).provider_configs;
  }

  it('starts a new Project’s backend key on the fixed openai and anthropic at equal weight', async () => {
    const seeded = await seededTenant();

    expect(backendProvidersOf(seeded)).toEqual(
      expect.arrayContaining([
        { provider: 'openai', weight: 1, ...CATALOG_WIDE },
        { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
      ])
    );
    expect(backendProvidersOf(seeded).map((config) => config.provider)).not.toContain('custom-openai-1');
    const openai = (await rowsOf(seeded)).find((row) => row.name === 'openai');
    expect(openai).toMatchObject({ backendEnabled: true, backendWeight: 1 });
  });

  it('follows an App switch and weight saved on the format card, leaving the chat key as it was', async () => {
    const seeded = await seededTenant();
    const chatBefore = bifrost.chatKeyOf(seeded.projectId).provider_configs;

    const res = await saveFormat(seeded, 'anthropic', [
      { name: 'anthropic', chatEnabled: true, chatWeight: 1, backendEnabled: true, backendWeight: 6 },
    ]);
    const off = await saveFormat(seeded, 'openai', [
      { name: 'openai', chatEnabled: true, chatWeight: 0, backendEnabled: false },
    ]);

    expect(res.statusCode, res.body).toBe(200);
    expect(off.statusCode, off.body).toBe(200);
    expect(backendProvidersOf(seeded)).toEqual([{ provider: 'anthropic', weight: 6, ...CATALOG_WIDE }]);
    expect(bifrost.chatKeyOf(seeded.projectId).provider_configs).toContainEqual({
      provider: 'openai',
      weight: 0,
      ...CATALOG_WIDE,
    });
    expect(chatBefore.length).toBe(bifrost.chatKeyOf(seeded.projectId).provider_configs.length);
  });

  it('keeps the App switch when a save leaves it out', async () => {
    const seeded = await seededTenant();

    const res = await saveFormat(seeded, 'openai', [{ name: 'openai', chatEnabled: true, chatWeight: 3 }]);

    expect(res.statusCode, res.body).toBe(200);
    expect((await rowsOf(seeded)).find((row) => row.name === 'openai')).toMatchObject({
      chatWeight: 3,
      backendEnabled: true,
      backendWeight: 1,
    });
  });

  it('refuses Apps on only at weight 0, and a malformed App switch', async () => {
    const seeded = await seededTenant();

    const zero = await saveFormat(seeded, 'anthropic', [
      { name: 'anthropic', chatEnabled: true, chatWeight: 1, backendEnabled: true, backendWeight: 0 },
    ]);
    const malformed = await saveFormat(seeded, 'anthropic', [
      { name: 'anthropic', chatEnabled: true, chatWeight: 1, backendEnabled: 'yes' },
    ]);

    expect(zero.statusCode).toBe(400);
    expect(zero.json<{ message: string }>().message).toContain('App weight');
    expect(malformed.statusCode).toBe(400);
    expect(backendProvidersOf(seeded)).toContainEqual({ provider: 'anthropic', weight: 1, ...CATALOG_WIDE });
  });

  it('starts a Custom model provider on for Apps at weight 1', async () => {
    const seeded = await seededTenant();

    const created = await app.inject({
      method: 'POST',
      url: '/api/model-providers',
      headers: seeded.admin.headers,
      payload: { baseFormat: 'openai', kind: 'official-api-key', name: 'apps', key: 'sk-apps' },
    });

    expect(created.statusCode, created.body).toBe(201);
    expect((await rowsOf(seeded)).find((row) => row.name === 'apps')).toMatchObject({
      backendEnabled: true,
      backendWeight: 1,
    });
    expect(backendProvidersOf(seeded)).toContainEqual({
      provider: `${seeded.tenant.name}-apps`,
      weight: 1,
      ...OPENAI_FAMILY,
    });
  });
});
