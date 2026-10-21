import { isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { modelProviders } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { CUTOVER_PLATFORM_PROVIDER_ROWS } from '../support/cutover-platform-providers';
import { startFakeBifrost, type FakeBifrost, type RecordedBifrostWrite } from '../support/fake-bifrost';
import { startFakeVendorApi, type FakeVendorApi } from './support/fake-vendor-api';
import { addMember, createTenant } from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const STANDARD_PROVIDER_NETWORK_CONFIG = {
  default_request_timeout_in_seconds: 1200,
  max_retries: 2,
  retry_backoff_initial: 500,
  retry_backoff_max: 5000,
  stream_idle_timeout_in_seconds: 3600,
};

interface TenantRow {
  name: string;
  chatEnabled: boolean;
  chatWeight: number;
}

describe('the fresh-install seed of the built-in model providers', () => {
  let bifrost: FakeBifrost;
  let vendor: FakeVendorApi;
  let harness: PublicApiTestApp | null = null;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    vendor = await startFakeVendorApi();
  });

  beforeEach(async () => {
    await db.delete(modelProviders).where(isNull(modelProviders.tenantId));
    bifrost.setProviders([]);
  });

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  afterAll(async () => {
    await db.delete(modelProviders).where(isNull(modelProviders.tenantId));
    await db.insert(modelProviders).values(CUTOVER_PLATFORM_PROVIDER_ROWS);
    await bifrost.close();
    await vendor.close();
  });

  async function boot(apiKeys: Record<string, string>): Promise<PublicApiTestApp> {
    harness = await createPublicApiTestApp(
      {
        ...bifrost.env,
        ...apiKeys,
        MODEL_PROVIDER_OFFICIAL_API_URLS: JSON.stringify({ openai: vendor.baseUrl, anthropic: vendor.baseUrl }),
      },
      [ModelProvidersModule],
      [BifrostService]
    );
    return harness;
  }

  async function newTenantRows(booted: PublicApiTestApp): Promise<TenantRow[]> {
    const tenant = await createTenant(booted.app);
    const admin = await addMember(booted.app, tenant, [Perms.manageTenantModelProviders]);
    const res = await booted.app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res
      .json<{ providers: TenantRow[] }>()
      .providers.map(({ name, chatEnabled, chatWeight }) => ({ name, chatEnabled, chatWeight }));
  }

  function providerCreations(): string[] {
    return bifrost.requests
      .filter((request) => request.method === 'POST' && request.path === '/api/providers')
      .map((request) => String((request.body as { provider?: string }).provider));
  }

  function providerWrites(): RecordedBifrostWrite[] {
    return bifrost.requests.filter((request) => request.method !== 'GET' && request.path.startsWith('/api/providers'));
  }

  it('creates openai and anthropic from the environment, tested, at weight 1 each for new Organizations', async () => {
    const booted = await boot({ OPENAI_API_KEY: 'sk-seed-openai', ANTHROPIC_API_KEY: 'sk-ant-seed' });

    for (const name of ['openai', 'anthropic']) {
      expect(bifrost.providerNamed(name)?.created).toEqual({
        provider: name,
        network_config: STANDARD_PROVIDER_NETWORK_CONFIG,
      });
    }
    expect(bifrost.providerNamed('openai')?.keys).toMatchObject([
      { value: { value: 'sk-seed-openai', type: 'plain_text' }, models: ['*'] },
    ]);
    expect(bifrost.providerNamed('anthropic')?.keys).toMatchObject([
      { value: { value: 'sk-ant-seed', type: 'plain_text' }, models: ['*'] },
    ]);
    expect(vendor.requests.some((request) => request.headers.authorization === 'Bearer sk-seed-openai')).toBe(true);
    expect(vendor.requests.some((request) => request.headers['x-api-key'] === 'sk-ant-seed')).toBe(true);
    expect(bifrost.providerNamed('custom-openai-1')).toBeUndefined();
    expect(await newTenantRows(booted)).toEqual([
      { name: 'anthropic', chatEnabled: true, chatWeight: 1 },
      { name: 'openai', chatEnabled: true, chatWeight: 1 },
    ]);
  });

  it('never runs again once seeded, whatever the environment says later', async () => {
    await boot({ OPENAI_API_KEY: 'sk-seed-openai', ANTHROPIC_API_KEY: 'sk-ant-seed' });
    await harness?.close();
    harness = null;
    const creationsBefore = providerCreations().length;
    bifrost.loseProvider('anthropic');

    await boot({ OPENAI_API_KEY: 'sk-other-openai', ANTHROPIC_API_KEY: 'sk-ant-other' });

    expect(providerCreations()).toHaveLength(creationsBefore);
    expect(bifrost.providerNamed('anthropic')).toBeUndefined();
    expect(bifrost.providerNamed('openai')?.keys).toMatchObject([{ value: { value: 'sk-seed-openai' } }]);
  });

  it('does nothing when platform providers already exist', async () => {
    await db.insert(modelProviders).values(CUTOVER_PLATFORM_PROVIDER_ROWS);
    const creationsBefore = providerCreations().length;

    await boot({ OPENAI_API_KEY: 'sk-seed-openai', ANTHROPIC_API_KEY: 'sk-ant-seed' });

    expect(providerCreations()).toHaveLength(creationsBefore);
  });

  it('seeds only the providers whose key is set', async () => {
    const booted = await boot({ ANTHROPIC_API_KEY: 'sk-ant-only' });

    expect(bifrost.providerNamed('openai')).toBeUndefined();
    expect(await newTenantRows(booted)).toEqual([{ name: 'anthropic', chatEnabled: true, chatWeight: 1 }]);
  });

  it('adopts the openai and anthropic that Helm already declares in Bifrost, leaving their keys alone', async () => {
    bifrost.setProviders(['openai', 'anthropic']);
    const providerWritesBefore = providerWrites().length;
    const vendorRequestsBefore = vendor.requests.length;

    const booted = await boot({ OPENAI_API_KEY: 'sk-helm-openai', ANTHROPIC_API_KEY: 'sk-ant-helm' });

    expect(providerWrites()).toHaveLength(providerWritesBefore);
    expect(vendor.requests).toHaveLength(vendorRequestsBefore);
    expect(await newTenantRows(booted)).toEqual([
      { name: 'anthropic', chatEnabled: true, chatWeight: 1 },
      { name: 'openai', chatEnabled: true, chatWeight: 1 },
    ]);
  });

  it('adopts what Bifrost holds without an environment key and creates only what it lacks', async () => {
    bifrost.setProviders(['openai']);
    const creationsBefore = providerCreations().length;

    const booted = await boot({ ANTHROPIC_API_KEY: 'sk-ant-seed' });

    expect(providerCreations().slice(creationsBefore)).toEqual(['anthropic']);
    expect(bifrost.providerNamed('openai')?.keys).toEqual([]);
    expect(await newTenantRows(booted)).toEqual([
      { name: 'anthropic', chatEnabled: true, chatWeight: 1 },
      { name: 'openai', chatEnabled: true, chatWeight: 1 },
    ]);
  });

  it('seeds nothing from a key that fails its test, and tries again at the next boot', async () => {
    vendor.replyWith(401);
    await boot({ OPENAI_API_KEY: 'sk-seed-wrong' });
    await harness?.close();
    harness = null;
    expect(bifrost.providerNamed('openai')).toBeUndefined();
    vendor.replyWith('models');

    const booted = await boot({ OPENAI_API_KEY: 'sk-seed-right' });

    expect(bifrost.providerNamed('openai')?.keys).toMatchObject([{ value: { value: 'sk-seed-right' } }]);
    expect(await newTenantRows(booted)).toEqual([{ name: 'openai', chatEnabled: true, chatWeight: 1 }]);
  });
});
