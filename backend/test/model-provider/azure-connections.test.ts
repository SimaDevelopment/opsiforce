import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { modelProviderAvailability, modelProviders, projectVirtualKeys } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { BASE_FORMATS } from '../../src/model-provider/base-formats';
import { servedModelsOf } from '../../src/model-provider/bifrost-provider-shape';
import { startFakeBifrost, type FakeBifrost, type FakeProviderConfig } from '../support/fake-bifrost';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';
import { startFakeVendorApi, type FakeVendorApi } from './support/fake-vendor-api';

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const AZURE_HOST = 'res.openai.azure.com';
const ENDPOINT = `https://${AZURE_HOST}`;

interface SeededTenant {
  tenant: TenantFixture;
  admin: MemberFixture;
  projectId: string;
}

interface Row {
  name: string;
  baseFormat: string | null;
  kind?: string | null;
  chatEnabled: boolean;
  chatWeight: number;
  backendWeight: number;
  servedModels?: string[];
  baseUrl?: string;
  url?: string | null;
  connection?: { models: string[]; deployments: Record<string, string> };
}

interface FamilyRow {
  baseFormat: 'openai' | 'anthropic';
  chatEnabled: boolean;
  chatWeight: number;
  backendEnabled: boolean;
  backendWeight: number;
}

const GPT: FamilyRow = {
  baseFormat: 'openai',
  chatEnabled: true,
  chatWeight: 2,
  backendEnabled: true,
  backendWeight: 1,
};
const CLAUDE: FamilyRow = {
  baseFormat: 'anthropic',
  chatEnabled: true,
  chatWeight: 1,
  backendEnabled: false,
  backendWeight: 1,
};

describe('Azure connections: named keys of the gateway’s one azure provider', () => {
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
    platformAdmin = await addMember(app, await createTenant(app), ['can_manage_platform_model_providers']);
    vendor.servedOverHttpsAt(AZURE_HOST);
  });

  afterEach(async () => {
    bifrost.becomeReachable();
    bifrost.setProviders(HELM_PROVIDERS);
    vendor.replyWith('models');
    await db.delete(modelProviders).where(eq(modelProviders.bifrostProvider, 'azure'));
    await db.delete(modelProviderAvailability);
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await vendor.close();
  });

  async function seededTenant(): Promise<SeededTenant> {
    const tenant = await createTenant(app);
    const admin = await addMember(app, tenant, ['can_manage_tenant_model_providers']);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: (await addMember(app, tenant)).headers,
      payload: { title: 'Routed', agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { tenant, admin, projectId: res.json<{ id: string }>().id };
  }

  async function holdEveryProjectKey(): Promise<void> {
    const keys = await db.select({ id: projectVirtualKeys.bifrostKeyId }).from(projectVirtualKeys);
    bifrost.holdVirtualKeys(keys.map((key) => key.id));
  }

  async function declareHelmKey(models: string[], families: FamilyRow[]): Promise<string> {
    const key = bifrost.addAzureKey('azure-foundry', models);
    await db.insert(modelProviders).values(
      families.map((family) => ({
        tenantId: null,
        bifrostProvider: 'azure',
        bifrostKey: 'azure-foundry',
        ...family,
      }))
    );
    return key.id;
  }

  function azureEntriesOf(configs: FakeProviderConfig[]) {
    return configs.filter((config) => config.provider === 'azure');
  }

  async function rowsOf(seeded: SeededTenant): Promise<Row[]> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: seeded.admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: Row[] }>().providers;
  }

  async function platformRows(): Promise<Row[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/platform-model-providers',
      headers: platformAdmin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: Row[] }>().providers;
  }

  function saveCard(seeded: SeededTenant, format: string, providers: Record<string, unknown>[]) {
    return app.inject({
      method: 'PUT',
      url: `/api/model-providers/formats/${format}`,
      headers: seeded.admin.headers,
      payload: { providers },
    });
  }

  function setPlatformModels(name: string, payload: Record<string, unknown>, member = platformAdmin) {
    return app.inject({
      method: 'PUT',
      url: `/api/platform-model-providers/${name}/models`,
      headers: member.headers,
      payload,
    });
  }

  async function createPlatformConnection(payload: Record<string, unknown>) {
    await holdEveryProjectKey();
    return app.inject({
      method: 'POST',
      url: '/api/platform-model-providers',
      headers: platformAdmin.headers,
      payload: {
        baseFormat: 'openai',
        kind: 'azure-foundry',
        name: 'foundry',
        key: 'az-key',
        endpoint: ENDPOINT,
        models: ['gpt-5.6-sol', 'claude-sonnet-5'],
        ...payload,
      },
    });
  }

  describe('the model lists on key entries', () => {
    it('lists a Custom model provider’s own family of models, so it never takes the other family’s requests', async () => {
      const seeded = await seededTenant();

      const created = await app.inject({
        method: 'POST',
        url: '/api/model-providers',
        headers: seeded.admin.headers,
        payload: { baseFormat: 'anthropic', kind: 'official-api-key', name: 'claude-own', key: 'sk-ant-own' },
      });

      expect(created.statusCode, created.body).toBe(201);
      const custom = `${seeded.tenant.name}-claude-own`;
      const anthropicModels = servedModelsOf(BASE_FORMATS.anthropic);
      for (const configs of [
        bifrost.chatKeyOf(seeded.projectId).provider_configs,
        bifrost.backendKeyOf(seeded.projectId).provider_configs,
      ]) {
        expect(configs.filter((config) => config.provider === custom)).toEqual([
          expect.objectContaining({ allowed_models: anthropicModels }),
        ]);
        expect(configs.filter((config) => config.provider === 'anthropic')).toEqual([
          expect.objectContaining({ allowed_models: ['*'] }),
        ]);
      }
    });

    it('lists a key-less provider’s whole format, since it has no key to read models from', async () => {
      bifrost.addProvider('keyless-dock');
      const dock = bifrost.providerNamed('keyless-dock');
      if (!dock) throw new Error('The fake Bifrost has no keyless-dock');
      dock.baseProviderType = 'openai';
      dock.keyLess = true;
      dock.created = { custom_provider_config: { allowed_requests: { list_models: false } } };
      await db
        .insert(modelProviders)
        .values({ tenantId: null, bifrostProvider: 'keyless-dock', chatEnabled: true, chatWeight: 1 });
      try {
        const seeded = await seededTenant();

        expect(bifrost.chatKeyOf(seeded.projectId).provider_configs).toContainEqual(
          expect.objectContaining({ provider: 'keyless-dock', allowed_models: servedModelsOf(BASE_FORMATS.openai) })
        );
      } finally {
        await db.delete(modelProviders).where(eq(modelProviders.bifrostProvider, 'keyless-dock'));
      }
    });

    it('writes only the ticked models on a Custom model provider’s key, and every model when all are ticked', async () => {
      const seeded = await seededTenant();

      const created = await app.inject({
        method: 'POST',
        url: '/api/model-providers',
        headers: seeded.admin.headers,
        payload: {
          baseFormat: 'openai',
          kind: 'official-api-key',
          name: 'only-sol',
          key: 'sk-sol',
          models: ['gpt-5.6-sol'],
        },
      });

      expect(created.statusCode, created.body).toBe(201);
      const custom = `${seeded.tenant.name}-only-sol`;
      expect(bifrost.providerNamed(custom)?.keys[0]?.models).toEqual(['gpt-5.6-sol']);
      expect(bifrost.chatKeyOf(seeded.projectId).provider_configs).toContainEqual(
        expect.objectContaining({ provider: custom, allowed_models: ['gpt-5.6-sol'] })
      );
      expect((await rowsOf(seeded)).find((row) => row.name === 'only-sol')?.servedModels).toEqual(['gpt-5.6-sol']);

      const edited = await app.inject({
        method: 'PATCH',
        url: '/api/model-providers/only-sol',
        headers: seeded.admin.headers,
        payload: { key: 'sk-sol-2' },
      });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(bifrost.providerNamed(custom)?.keys[0]?.models).toEqual(['gpt-5.6-sol']);

      const widened = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/only-sol/models',
        headers: seeded.admin.headers,
        payload: { models: null },
      });

      expect(widened.statusCode, widened.body).toBe(200);
      expect(bifrost.providerNamed(custom)?.keys[0]?.models).toEqual(['*']);
      expect((await rowsOf(seeded)).find((row) => row.name === 'only-sol')?.servedModels).toBeUndefined();
    });

    it('puts a Custom provider’s key back when a Project key refuses its model change', async () => {
      const seeded = await seededTenant();
      const created = await app.inject({
        method: 'POST',
        url: '/api/model-providers',
        headers: seeded.admin.headers,
        payload: {
          baseFormat: 'openai',
          kind: 'official-api-key',
          name: 'narrowing',
          key: 'sk-n',
          models: ['gpt-5.6-sol'],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const custom = `${seeded.tenant.name}-narrowing`;

      bifrost.refuseProviderConfigWrites(bifrost.chatKeyOf(seeded.projectId).id);
      const refused = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/narrowing/models',
        headers: seeded.admin.headers,
        payload: { models: ['gpt-6-astra'] },
      });
      bifrost.acceptProviderConfigWrites();

      expect(refused.statusCode).toBeGreaterThanOrEqual(500);
      expect(bifrost.providerNamed(custom)?.keys[0]?.models).toEqual(['gpt-5.6-sol']);
      expect(bifrost.chatKeyOf(seeded.projectId).provider_configs).toContainEqual(
        expect.objectContaining({ provider: custom, allowed_models: ['gpt-5.6-sol'] })
      );
    });

    it('refuses a model outside the catalog of the provider’s format', async () => {
      const seeded = await seededTenant();

      const res = await app.inject({
        method: 'POST',
        url: '/api/model-providers',
        headers: seeded.admin.headers,
        payload: {
          baseFormat: 'openai',
          kind: 'official-api-key',
          name: 'wrong-family',
          key: 'sk-x',
          models: ['claude-sonnet-5'],
        },
      });

      expect(res.statusCode, res.body).toBe(400);
    });
  });

  describe('a key declared in the deployment, one row per Base format', () => {
    it('writes one entry per family row, restricted to its key and that family’s models, with its own weights', async () => {
      const keyId = await declareHelmKey(['gpt-5.6-sol', 'claude-sonnet-5', 'outside-the-catalog'], [GPT, CLAUDE]);
      const seeded = await seededTenant();

      expect((await rowsOf(seeded)).filter((row) => row.name === 'azure-foundry')).toEqual([
        expect.objectContaining({ baseFormat: 'anthropic', chatWeight: 1, servedModels: ['claude-sonnet-5'] }),
        expect.objectContaining({ baseFormat: 'openai', chatWeight: 2, servedModels: ['gpt-5.6-sol'] }),
      ]);
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([
        { provider: 'azure', weight: 1, allowed_models: ['claude-sonnet-5'], key_ids: [keyId] },
        { provider: 'azure', weight: 2, allowed_models: ['gpt-5.6-sol'], key_ids: [keyId] },
      ]);
      expect(azureEntriesOf(bifrost.backendKeyOf(seeded.projectId).provider_configs)).toEqual([
        { provider: 'azure', weight: 1, allowed_models: ['gpt-5.6-sol'], key_ids: [keyId] },
      ]);
    });

    it('weighs and switches each family on its own card', async () => {
      await declareHelmKey(['gpt-5.6-sol', 'claude-sonnet-5'], [GPT, CLAUDE]);
      const seeded = await seededTenant();

      const weighed = await saveCard(seeded, 'openai', [{ name: 'azure-foundry', chatEnabled: true, chatWeight: 5 }]);
      expect(weighed.statusCode, weighed.body).toBe(200);
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([
        expect.objectContaining({ weight: 1, allowed_models: ['claude-sonnet-5'] }),
        expect.objectContaining({ weight: 5, allowed_models: ['gpt-5.6-sol'] }),
      ]);

      const off = await saveCard(seeded, 'anthropic', [{ name: 'azure-foundry', chatEnabled: false }]);
      expect(off.statusCode, off.body).toBe(200);
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([
        expect.objectContaining({ weight: 5, allowed_models: ['gpt-5.6-sol'] }),
      ]);
    });

    it('shows a family row whose key serves none of its models as serving none, and writes no entry for it', async () => {
      await declareHelmKey(['gpt-5.6-sol'], [GPT, CLAUDE]);
      const seeded = await seededTenant();

      expect(
        (await rowsOf(seeded)).find((row) => row.name === 'azure-foundry' && row.baseFormat === 'anthropic')
      ).toEqual(expect.objectContaining({ servedModels: [] }));
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([
        expect.objectContaining({ allowed_models: ['gpt-5.6-sol'] }),
      ]);
    });

    it('shows a row whose key is gone from the gateway as missing, and writes no entry for it', async () => {
      await db.insert(modelProviders).values({ tenantId: null, bifrostProvider: 'azure', bifrostKey: 'gone', ...GPT });
      bifrost.addAzureKey('another-key', ['gpt-5.6-sol']);
      const seeded = await seededTenant();

      expect((await rowsOf(seeded)).find((row) => row.name === 'gone')).toEqual(
        expect.objectContaining({ status: 'missing' })
      );
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([]);
    });

    it('lists each family row to platform admins with its models', async () => {
      await declareHelmKey(['gpt-5.6-sol', 'claude-sonnet-5'], [GPT, CLAUDE]);

      expect((await platformRows()).filter((row) => row.name === 'azure-foundry')).toEqual([
        expect.objectContaining({
          baseFormat: 'anthropic',
          kind: 'azure-foundry',
          url: null,
          servedModels: ['claude-sonnet-5'],
        }),
        expect.objectContaining({
          baseFormat: 'openai',
          kind: 'azure-foundry',
          url: null,
          servedModels: ['gpt-5.6-sol'],
        }),
      ]);
    });

    it('makes reachable only the models on its key, so pickers hide the family’s other models', async () => {
      await declareHelmKey(['gpt-5.6-sol', 'claude-sonnet-5'], [GPT, CLAUDE]);
      const seeded = await seededTenant();
      const anthropicOff = await saveCard(seeded, 'anthropic', [{ name: 'anthropic', chatEnabled: false }]);
      expect(anthropicOff.statusCode, anthropicOff.body).toBe(200);

      const res = await app.inject({
        method: 'GET',
        url: '/api/model-providers/reachable-models',
        headers: seeded.admin.headers,
      });

      expect(res.statusCode, res.body).toBe(200);
      const reachable = res.json<string[]>();
      expect(reachable.filter((ref) => ref.startsWith('anthropic/'))).toEqual(['anthropic/claude-sonnet-5']);
      expect(reachable).toContain('openai/gpt-6-astra');
    });

    it('is never edited or deleted through the platform routes', async () => {
      await declareHelmKey(['gpt-5.6-sol'], [GPT]);

      const edited = await app.inject({
        method: 'PATCH',
        url: '/api/platform-model-providers/azure-foundry',
        headers: platformAdmin.headers,
        payload: { key: 'az', endpoint: ENDPOINT, models: ['gpt-5.6-sol'] },
      });
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/platform-model-providers/azure-foundry',
        headers: platformAdmin.headers,
      });

      expect(edited.statusCode).toBe(400);
      expect(deleted.statusCode).toBe(400);
      expect(bifrost.azureKeyNamed('azure-foundry')).toBeDefined();
    });
  });

  describe('a Built-in Azure connection added by a platform admin', () => {
    it('tests the endpoint with the key, then stores a named key on the azure provider with its models and deployments', async () => {
      const created = await createPlatformConnection({ deployments: { 'claude-sonnet-5': 'my-sonnet' } });

      expect(created.statusCode, created.body).toBe(201);
      expect(vendor.requests.at(-1)).toEqual(
        expect.objectContaining({
          path: '/openai/v1/models',
          headers: expect.objectContaining({ 'api-key': 'az-key' }),
        })
      );
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toEqual(
        expect.objectContaining({
          models: ['gpt-5.6-sol', 'claude-sonnet-5'],
          azure_key_config: { endpoint: { value: ENDPOINT, type: 'plain_text' } },
          aliases: { 'claude-sonnet-5': { model_id: 'my-sonnet', model_family: 'anthropic' } },
        })
      );
      expect((await platformRows()).filter((row) => row.name === 'opsiforce-foundry')).toEqual([
        expect.objectContaining({
          baseFormat: 'anthropic',
          kind: 'azure-foundry',
          url: ENDPOINT,
          notMetered: false,
          connection: { models: ['gpt-5.6-sol', 'claude-sonnet-5'], deployments: { 'claude-sonnet-5': 'my-sonnet' } },
        }),
        expect.objectContaining({ baseFormat: 'openai', kind: 'azure-foundry', url: ENDPOINT }),
      ]);
    });

    it('starts switched off; an Organization admin turns its family on and the entry uses only its key', async () => {
      const seeded = await seededTenant();
      expect((await createPlatformConnection({})).statusCode).toBe(201);
      const keyId = bifrost.azureKeyNamed('opsiforce-foundry')?.id;

      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([]);
      const on = await saveCard(seeded, 'openai', [{ name: 'opsiforce-foundry', chatEnabled: true, chatWeight: 3 }]);

      expect(on.statusCode, on.body).toBe(200);
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([
        { provider: 'azure', weight: 3, allowed_models: ['gpt-5.6-sol'], key_ids: [keyId] },
      ]);
    });

    it('keeps two connections on the azure provider apart, each entry restricted to its own key', async () => {
      const helmKeyId = await declareHelmKey(['gpt-5.6-sol'], [GPT]);
      const seeded = await seededTenant();
      expect((await createPlatformConnection({ models: ['gpt-5.6-sol'] })).statusCode).toBe(201);
      const keyId = bifrost.azureKeyNamed('opsiforce-foundry')?.id;

      const on = await saveCard(seeded, 'openai', [{ name: 'opsiforce-foundry', chatEnabled: true, chatWeight: 1 }]);

      expect(on.statusCode, on.body).toBe(200);
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ weight: 2, key_ids: [helmKeyId] }),
          expect.objectContaining({ weight: 1, key_ids: [keyId] }),
        ])
      );
    });

    it('keeps every catalog model reachable while the gateway can’t read provider keys', async () => {
      const seeded = await seededTenant();
      expect((await createPlatformConnection({ models: ['gpt-5.6-sol'] })).statusCode).toBe(201);
      const openAiRows = (await rowsOf(seeded)).filter((row) => row.baseFormat === 'openai');
      const onlyAzure = await saveCard(
        seeded,
        'openai',
        openAiRows.map((row) =>
          row.name === 'opsiforce-foundry'
            ? { name: row.name, chatEnabled: true, chatWeight: 1 }
            : { name: row.name, chatEnabled: false }
        )
      );
      expect(onlyAzure.statusCode, onlyAzure.body).toBe(200);
      const reachable = async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/model-providers/reachable-models',
          headers: seeded.admin.headers,
        });
        expect(res.statusCode, res.body).toBe(200);
        return res.json<string[]>();
      };

      expect((await reachable()).filter((ref) => ref.startsWith('openai/'))).toEqual(['openai/gpt-5.6-sol']);

      bifrost.refuseKeyReadsOf('azure');
      try {
        expect(await reachable()).toContain('openai/gpt-6-astra');
      } finally {
        bifrost.refuseKeyReadsOf(null);
      }
    });

    it('is offered only to the chosen Organizations', async () => {
      const chosen = await seededTenant();
      const other = await seededTenant();

      const created = await createPlatformConnection({
        availability: { mode: 'chosen', tenantIds: [chosen.tenant.tenantId] },
      });

      expect(created.statusCode, created.body).toBe(201);
      expect((await rowsOf(chosen)).map((row) => row.name)).toContain('opsiforce-foundry');
      expect((await rowsOf(other)).map((row) => row.name)).not.toContain('opsiforce-foundry');
    });

    it('stores nothing when the connection test fails', async () => {
      vendor.replyWith(401);

      const res = await createPlatformConnection({});

      expect(res.statusCode, res.body).toBe(422);
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toBeUndefined();
      expect((await platformRows()).map((row) => row.name)).not.toContain('opsiforce-foundry');
    });

    it('refuses an endpoint outside Azure, an endpoint with a path, no models and a model outside the catalog', async () => {
      for (const payload of [
        { endpoint: 'https://example.com' },
        { endpoint: `${ENDPOINT}/openai/v1` },
        { models: [] },
        { models: ['gpt-5.6-sol', 'outside-the-catalog'] },
        { deployments: { 'gpt-5.6-sol': 'has spaces' } },
      ]) {
        const res = await createPlatformConnection(payload);
        expect(res.statusCode, `${JSON.stringify(payload)}: ${res.body}`).toBe(400);
      }
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toBeUndefined();
    });

    it('edits only the endpoint and key, keeping its models and deployments', async () => {
      expect((await createPlatformConnection({ deployments: { 'claude-sonnet-5': 'my-sonnet' } })).statusCode).toBe(
        201
      );

      const edited = await app.inject({
        method: 'PATCH',
        url: '/api/platform-model-providers/opsiforce-foundry',
        headers: platformAdmin.headers,
        payload: { key: 'az-key-2', endpoint: ENDPOINT },
      });

      expect(edited.statusCode, edited.body).toBe(200);
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toEqual(
        expect.objectContaining({
          value: { value: 'az-key-2', type: 'plain_text' },
          models: ['gpt-5.6-sol', 'claude-sonnet-5'],
          aliases: { 'claude-sonnet-5': { model_id: 'my-sonnet', model_family: 'anthropic' } },
        })
      );
    });

    it('serves every model by default, and keeps one row per family its chosen models span', async () => {
      expect((await createPlatformConnection({ models: undefined })).statusCode).toBe(201);
      expect(bifrost.azureKeyNamed('opsiforce-foundry')?.models).toEqual(['*']);
      const familiesOf = async () =>
        (await platformRows()).filter((row) => row.name === 'opsiforce-foundry').map((row) => row.baseFormat);
      expect(await familiesOf()).toEqual(['anthropic', 'openai']);
      await holdEveryProjectKey();

      const narrowed = await setPlatformModels('opsiforce-foundry', {
        models: ['gpt-5.6-sol'],
        deployments: { 'gpt-5.6-sol': 'sol-prod' },
      });

      expect(narrowed.statusCode, narrowed.body).toBe(200);
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toEqual(
        expect.objectContaining({ models: ['gpt-5.6-sol'], aliases: { 'gpt-5.6-sol': 'sol-prod' } })
      );
      expect(await familiesOf()).toEqual(['openai']);

      const widened = await setPlatformModels('opsiforce-foundry', { models: null });

      expect(widened.statusCode, widened.body).toBe(200);
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toEqual(
        expect.objectContaining({ models: ['*'], aliases: {} })
      );
      expect(await familiesOf()).toEqual(['anthropic', 'openai']);
    });

    it('removes its key and rows when deleted, leaving the azure provider’s other keys', async () => {
      await declareHelmKey(['gpt-5.6-sol'], [GPT]);
      expect((await createPlatformConnection({})).statusCode).toBe(201);
      await holdEveryProjectKey();

      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/platform-model-providers/opsiforce-foundry',
        headers: platformAdmin.headers,
      });

      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(bifrost.azureKeyNamed('opsiforce-foundry')).toBeUndefined();
      expect(bifrost.azureKeyNamed('azure-foundry')).toBeDefined();
      expect((await platformRows()).map((row) => row.name)).not.toContain('opsiforce-foundry');
    });
  });

  describe('an Organization’s own Azure connection', () => {
    async function createOwn(seeded: SeededTenant) {
      await holdEveryProjectKey();
      return app.inject({
        method: 'POST',
        url: '/api/model-providers',
        headers: seeded.admin.headers,
        payload: {
          baseFormat: 'openai',
          kind: 'azure-foundry',
          name: 'own-foundry',
          key: 'az-own',
          endpoint: ENDPOINT,
          models: ['gpt-5.6-sol', 'claude-sonnet-5'],
        },
      });
    }

    it('is on for Agents and apps at once, on both families, restricted to its own key', async () => {
      const seeded = await seededTenant();

      const created = await createOwn(seeded);

      expect(created.statusCode, created.body).toBe(201);
      const keyName = `${seeded.tenant.name}-own-foundry`;
      const keyId = bifrost.azureKeyNamed(keyName)?.id;
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([
        { provider: 'azure', weight: 1, allowed_models: ['claude-sonnet-5'], key_ids: [keyId] },
        { provider: 'azure', weight: 1, allowed_models: ['gpt-5.6-sol'], key_ids: [keyId] },
      ]);
      expect((await rowsOf(seeded)).filter((row) => row.name === 'own-foundry')).toEqual([
        expect.objectContaining({ baseFormat: 'anthropic', kind: 'azure-foundry', baseUrl: ENDPOINT }),
        expect.objectContaining({
          baseFormat: 'openai',
          kind: 'azure-foundry',
          baseUrl: ENDPOINT,
          connection: { models: ['gpt-5.6-sol', 'claude-sonnet-5'], deployments: {} },
        }),
      ]);
    });

    it('is out of reach of the platform routes, so it never becomes a Built-in', async () => {
      const seeded = await seededTenant();
      const other = await seededTenant();
      expect((await createOwn(seeded)).statusCode).toBe(201);
      const keyName = `${seeded.tenant.name}-own-foundry`;
      await holdEveryProjectKey();

      const models = await setPlatformModels(keyName, { models: ['gpt-5.6-sol'] });
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/platform-model-providers/${keyName}`,
        headers: platformAdmin.headers,
      });

      expect(models.statusCode).toBe(404);
      expect([400, 404]).toContain(deleted.statusCode);
      expect(bifrost.azureKeyNamed(keyName)?.models).toEqual(['gpt-5.6-sol', 'claude-sonnet-5']);
      expect((await platformRows()).map((row) => row.name)).not.toContain(keyName);
      expect((await rowsOf(other)).map((row) => row.name)).not.toContain(keyName);
      expect((await rowsOf(seeded)).filter((row) => row.name === 'own-foundry')).toHaveLength(2);
    });

    it('puts its key and the Project keys back when a Project key refuses the change', async () => {
      const seeded = await seededTenant();
      expect((await createOwn(seeded)).statusCode).toBe(201);
      const keyName = `${seeded.tenant.name}-own-foundry`;
      const chatKey = bifrost.chatKeyOf(seeded.projectId);

      bifrost.refuseProviderConfigWrites(chatKey.id);
      const refused = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/own-foundry/models',
        headers: seeded.admin.headers,
        payload: { models: ['claude-sonnet-5'] },
      });
      bifrost.acceptProviderConfigWrites();

      expect(refused.statusCode).toBeGreaterThanOrEqual(500);
      expect(bifrost.azureKeyNamed(keyName)?.models).toEqual(['gpt-5.6-sol', 'claude-sonnet-5']);
      expect((await rowsOf(seeded)).filter((row) => row.name === 'own-foundry').map((row) => row.baseFormat)).toEqual([
        'anthropic',
        'openai',
      ]);
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toHaveLength(2);
    });

    it('first pins every Organization’s old azure entries to their own key, so none can reach the new one', async () => {
      const seeded = await seededTenant();
      const other = await seededTenant();
      const otherChat = bifrost.chatKeyOf(other.projectId);
      otherChat.provider_configs.push({
        provider: 'azure',
        weight: 0,
        allowed_models: ['gpt-5.6-sol'],
        key_ids: ['*'],
      });

      expect((await createOwn(seeded)).statusCode).toBe(201);

      expect(azureEntriesOf(bifrost.chatKeyOf(other.projectId).provider_configs)).toEqual([]);
    });

    it('is invisible to other Organizations', async () => {
      const seeded = await seededTenant();
      const other = await seededTenant();

      expect((await createOwn(seeded)).statusCode).toBe(201);

      expect((await rowsOf(other)).map((row) => row.name)).not.toContain('own-foundry');
      expect(azureEntriesOf(bifrost.chatKeyOf(other.projectId).provider_configs)).toEqual([]);
    });

    it('refuses re-entering its key, and removes its key when deleted', async () => {
      const seeded = await seededTenant();
      expect((await createOwn(seeded)).statusCode).toBe(201);

      const reentered = await app.inject({
        method: 'POST',
        url: '/api/model-providers/own-foundry/re-enter-key',
        headers: seeded.admin.headers,
        payload: { key: 'az' },
      });
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/model-providers/own-foundry',
        headers: seeded.admin.headers,
      });

      expect(reentered.statusCode).toBe(400);
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(bifrost.azureKeyNamed(`${seeded.tenant.name}-own-foundry`)).toBeUndefined();
      expect(azureEntriesOf(bifrost.chatKeyOf(seeded.projectId).provider_configs)).toEqual([]);
    });
  });

  describe('the models a Built-in serves', () => {
    function giveOpenAiItsHelmKey() {
      const openai = bifrost.providerNamed('openai');
      if (!openai) throw new Error('The fake Bifrost has no openai');
      openai.keys.push({
        id: 'openai-primary-id',
        name: 'openai-primary',
        value: { value: '', ref: 'env.OPENAI_API_KEY', type: 'env' },
        models: ['*'],
        weight: 1,
        enabled: true,
      });
    }

    it('narrows openai for every Organization, keeping its key and the transcription model, and puts every model back', async () => {
      giveOpenAiItsHelmKey();
      const seeded = await seededTenant();
      await holdEveryProjectKey();
      const openAiEntry = () =>
        bifrost.chatKeyOf(seeded.projectId).provider_configs.find((config) => config.provider === 'openai');

      const narrowed = await setPlatformModels('openai', { models: ['gpt-5.6-sol'] });

      expect(narrowed.statusCode, narrowed.body).toBe(200);
      expect(bifrost.providerNamed('openai')?.keys).toEqual([
        expect.objectContaining({
          name: 'openai-primary',
          value: { value: '', ref: 'env.OPENAI_API_KEY', type: 'env' },
          models: ['gpt-5.6-sol', 'gpt-4o-mini-transcribe'],
        }),
      ]);
      expect(openAiEntry()).toEqual(
        expect.objectContaining({ allowed_models: ['gpt-5.6-sol', 'gpt-4o-mini-transcribe'] })
      );
      expect((await platformRows()).find((row) => row.name === 'openai')?.servedModels).toEqual(['gpt-5.6-sol']);

      const widened = await setPlatformModels('openai', { models: null });

      expect(widened.statusCode, widened.body).toBe(200);
      expect(bifrost.providerNamed('openai')?.keys[0]?.models).toEqual(['*']);
      expect(openAiEntry()).toEqual(expect.objectContaining({ allowed_models: ['*'] }));
    });

    it('refuses a model of the other format, a provider with no key, and an Organization admin', async () => {
      giveOpenAiItsHelmKey();
      const seeded = await seededTenant();

      const otherFormat = await setPlatformModels('openai', { models: ['claude-sonnet-5'] });
      const keyLess = await setPlatformModels('custom-openai-1', { models: ['gpt-5.6-sol'] });
      const orgAdmin = await setPlatformModels('openai', { models: ['gpt-5.6-sol'] }, seeded.admin);
      const orgRoute = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/openai/models',
        headers: seeded.admin.headers,
        payload: { models: ['gpt-5.6-sol'] },
      });

      expect(otherFormat.statusCode).toBe(400);
      expect(keyLess.statusCode).toBe(409);
      expect(orgAdmin.statusCode).toBe(403);
      expect(orgRoute.statusCode).toBe(400);
      expect(bifrost.providerNamed('openai')?.keys[0]?.models).toEqual(['*']);
    });
  });
});
