import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { modelProviders } from '../../db/schema';
import { catalogModelIdsOf } from '../../src/agent/agent-models';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { TenantService } from '../../src/tenant/tenant.service';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { tenantName } from '../support/proxy-identity';
import {
  REDIRECT_TARGET_PATH,
  VENDOR_REPLY_MARKER,
  startFakeVendorApi,
  type FakeVendorApi,
  type FakeVendorReply,
} from './support/fake-vendor-api';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const OPENAI_CATALOG_IDS = catalogModelIdsOf('openai');
const NAME_TAKEN = 'That name is taken in this organization; choose another';
const ANTHROPIC_CATALOG_IDS = catalogModelIdsOf('anthropic');

interface ProviderRow {
  name: string;
  kind?: string | null;
  baseUrl?: string;
  baseFormat: string | null;
  enabled: boolean;
  weight: number;
  status: string;
}

interface ModelProvidersView {
  providers: ProviderRow[];
}

interface NewProvider {
  baseFormat: string;
  kind: string;
  name: string;
  key: string;
  baseUrl?: string;
}

function officialKey(overrides: Partial<NewProvider> = {}): NewProvider {
  return { baseFormat: 'openai', kind: 'official-api-key', name: 'own-key', key: 'sk-live-own', ...overrides };
}

const OPENAI_COMPATIBLE_PATHS = {
  chat_completion: '/chat/completions',
  chat_completion_stream: '/chat/completions',
};

describe('adding, editing and deleting a Custom model provider', () => {
  let bifrost: FakeBifrost;
  let vendor: FakeVendorApi;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;
  let gatewayUrl: string;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    vendor = await startFakeVendorApi();
    gatewayUrl = vendor.servedOverHttpsAt('gateway.example.test');
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

  async function seededTenant(): Promise<{ tenant: TenantFixture; admin: MemberFixture }> {
    const tenant = await createTenant(app);
    return { tenant, admin: await addMember(app, tenant, [Perms.manageTenantModelProviders]) };
  }

  async function seededTenantNamed(name: string): Promise<{ tenant: TenantFixture; admin: MemberFixture }> {
    const tenant = { name, tenantId: (await app.get(TenantService).getOrCreateTenant(name)).id };
    return { tenant, admin: await addMember(app, tenant, [Perms.manageTenantModelProviders]) };
  }

  async function projectOf(tenant: TenantFixture): Promise<string> {
    const member = await addMember(app, tenant);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: member.headers,
      payload: { title: 'Routed', agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  function testConnection(admin: MemberFixture, provider: NewProvider) {
    return app.inject({ method: 'POST', url: '/api/model-providers/test', headers: admin.headers, payload: provider });
  }

  function create(admin: MemberFixture, provider: NewProvider) {
    return app.inject({ method: 'POST', url: '/api/model-providers', headers: admin.headers, payload: provider });
  }

  async function rowsOf(admin: MemberFixture): Promise<ProviderRow[]> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ModelProvidersView>().providers;
  }

  describe('create, test and save', () => {
    it('tests the key against the vendor, then saves a row switched on at weight 1 that the chat keys route to', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const bifrostName = `${tenant.name}-own-key`;

      const tested = await testConnection(admin, officialKey());
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json()).toEqual({ passed: true });
      expect(bifrost.providerNamed(bifrostName)).toBeUndefined();

      const created = await create(admin, officialKey());

      expect(created.statusCode, created.body).toBe(201);
      expect(created.json<ModelProvidersView>().providers).toContainEqual({
        name: 'own-key',
        kind: 'official-api-key',
        baseFormat: 'openai',
        enabled: true,
        weight: 1,
        status: 'working',
      });
      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
        { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
        { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
        { provider: 'openai', weight: 0, ...CATALOG_WIDE },
        { provider: bifrostName, weight: 1, ...CATALOG_WIDE },
      ]);
      const modelListCalls = vendor.requests.filter(
        (request) => request.headers.authorization === 'Bearer sk-live-own'
      );
      expect(modelListCalls.map((request) => `${request.method} ${request.path}`)).toEqual([
        'GET /v1/models',
        'GET /v1/models',
      ]);
    });
  });

  describe('a failed test', () => {
    const failures: Array<[string, FakeVendorReply, number, string]> = [
      ['a 401', 401, 422, 'The key was rejected'],
      ['a 403', 403, 422, 'The key was rejected'],
      ['an unreachable host', 'drop', 422, "Can't reach this address"],
      ['a redirect, without following it', 'redirect', 422, 'Enter the final URL'],
      ['any other status, by its number', 500, 422, 'The test failed with HTTP 500'],
    ];

    it.each(failures)('reports %s and never returns the reply body', async (_label, reply, status, message) => {
      const { tenant, admin } = await seededTenant();
      vendor.replyWith(reply);

      const tested = await testConnection(admin, officialKey());
      const created = await create(admin, officialKey());

      for (const res of [tested, created]) {
        expect(res.statusCode, res.body).toBe(status);
        expect(res.json<{ message: string }>().message).toBe(message);
        expect(res.body).not.toContain(VENDOR_REPLY_MARKER);
      }
      expect(vendor.requests.some((request) => request.path === REDIRECT_TARGET_PATH)).toBe(false);
      expect(bifrost.providerNamed(`${tenant.name}-own-key`)).toBeUndefined();
      expect((await rowsOf(admin)).map((row) => row.name)).not.toContain('own-key');
    });

    it('deletes the Bifrost provider it created and confirms the delete with a GET', async () => {
      const { tenant, admin } = await seededTenant();
      const bifrostName = `${tenant.name}-own-key`;
      vendor.replyWith(401);

      const res = await create(admin, officialKey());

      expect(res.statusCode, res.body).toBe(422);
      const calls = bifrost.requests
        .filter((request) => request.path.startsWith(`/api/providers/${bifrostName}`))
        .map((request) => `${request.method} ${request.path}`);
      expect(calls).toEqual([`DELETE /api/providers/${bifrostName}`, `GET /api/providers/${bifrostName}`]);
    });

    it('fails with the gateway’s refusal when Bifrost answers the delete but keeps the provider', async () => {
      const { tenant, admin } = await seededTenant();
      vendor.replyWith(401);
      bifrost.keepProvidersOnDelete();

      const res = await create(admin, officialKey());

      expect(res.statusCode, res.body).toBe(502);
      expect(bifrost.providerNamed(`${tenant.name}-own-key`)).toBeDefined();
      expect((await rowsOf(admin)).map((row) => row.name)).not.toContain('own-key');
    });

    it('rolls the provider back when the chat keys refuse the new split', async () => {
      const { tenant, admin } = await seededTenant();
      await projectOf(tenant);
      bifrost.refuseProviderConfigWrites();

      const res = await create(admin, officialKey());

      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      bifrost.acceptProviderConfigWrites();
      expect(bifrost.providerNamed(`${tenant.name}-own-key`)).toBeUndefined();
      expect((await rowsOf(admin)).map((row) => row.name)).not.toContain('own-key');
    });
  });

  describe('names and the limit', () => {
    it('tells the dialog the computed name limit, the Custom limit and the kinds it can add', async () => {
      const { tenant, admin } = await seededTenant();

      const res = await app.inject({
        method: 'GET',
        url: '/api/model-providers/creation-rules',
        headers: admin.headers,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        nameMaxLength: 49 - tenant.name.length,
        customProviderLimit: 10,
        customProviderCount: 0,
        kindsByFormat: {
          openai: ['official-api-key', 'compatible-endpoint', 'linked-account'],
          anthropic: ['official-api-key', 'compatible-endpoint'],
        },
      });
    });

    it('accepts a slug at the computed limit and refuses one character more', async () => {
      const { tenant, admin } = await seededTenant();
      const limit = 49 - tenant.name.length;

      const atLimit = await create(admin, officialKey({ name: 'a'.repeat(limit) }));
      const overLimit = await create(admin, officialKey({ name: 'b'.repeat(limit + 1) }));

      expect(atLimit.statusCode, atLimit.body).toBe(201);
      expect(bifrost.providerNamed(`${tenant.name}-${'a'.repeat(limit)}`)?.name).toHaveLength(50);
      expect(overLimit.statusCode).toBe(400);
      expect(overLimit.json<{ message: string }>().message).toBe(
        `A name in this organization is at most ${limit} characters`
      );
    });

    it.each([
      ['uppercase', 'Own-Key', 'A name uses only lowercase letters, digits and hyphens'],
      ['a space', 'own key', 'A name uses only lowercase letters, digits and hyphens'],
      ['an empty name', '', 'Enter a name'],
      ['a standard provider name', 'openai', 'openai is reserved for a standard provider; choose another name'],
      ['another standard provider name', 'azure', 'azure is reserved for a standard provider; choose another name'],
      [
        'a pricing-trap substring',
        'my-bedrock',
        'A name can\'t contain "bedrock": the model gateway would price its requests as that vendor\'s',
      ],
      [
        'another pricing-trap substring',
        'together-ai',
        'A name can\'t contain "together": the model gateway would price its requests as that vendor\'s',
      ],
    ])('refuses %s before touching Bifrost', async (_label, name, message) => {
      const { tenant, admin } = await seededTenant();

      const res = await create(admin, officialKey({ name }));

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe(message);
      expect(bifrost.providerNamed(`${tenant.name}-${name}`)).toBeUndefined();
    });

    it('refuses every name in an Organization whose own name would be priced as another vendor', async () => {
      const { tenant, admin } = await seededTenantNamed(tenantName('together-inc'));

      const res = await create(admin, officialKey());

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe(
        'This organization’s name contains "together": the model gateway would price its model providers’ requests as that vendor’s'
      );
      expect(bifrost.providerNamed(`${tenant.name}-own-key`)).toBeUndefined();
    });

    it('refuses a name already used in the Organization as taken', async () => {
      const { admin } = await seededTenant();
      expect((await create(admin, officialKey())).statusCode).toBe(201);

      const again = await create(admin, officialKey({ baseFormat: 'anthropic' }));
      const tested = await testConnection(admin, officialKey());

      for (const res of [again, tested]) {
        expect(res.statusCode).toBe(409);
        expect(res.json<{ message: string }>().message).toBe(NAME_TAKEN);
      }
      expect((await rowsOf(admin)).filter((row) => row.name === 'own-key')).toHaveLength(1);
    });

    it('surfaces a prefix collision with another Organization’s provider as taken and leaves that provider alone', async () => {
      const { tenant, admin } = await seededTenant();
      bifrost.addProvider(`${tenant.name}-shared`);

      const res = await create(admin, officialKey({ name: 'shared' }));

      expect(res.statusCode).toBe(409);
      expect(res.json<{ message: string }>().message).toBe(NAME_TAKEN);
      expect(bifrost.providerNamed(`${tenant.name}-shared`)).toBeDefined();
      expect(
        bifrost.requests.some(
          (request) => request.method === 'DELETE' && request.path === `/api/providers/${tenant.name}-shared`
        )
      ).toBe(false);
    });

    it('refuses a name whose gateway name another Organization holds, even while its provider is missing', async () => {
      const { tenant, admin } = await seededTenant();
      const neighbour = await seededTenantNamed(`${tenant.name}-x`);
      expect((await create(neighbour.admin, officialKey({ name: 'y' }))).statusCode).toBe(201);
      bifrost.loseProvider(`${tenant.name}-x-y`);

      const created = await create(admin, officialKey({ name: 'x-y' }));
      const tested = await testConnection(admin, officialKey({ name: 'x-y' }));

      for (const res of [created, tested]) {
        expect(res.statusCode).toBe(409);
        expect(res.json<{ message: string }>().message).toBe(NAME_TAKEN);
      }
      expect(bifrost.providerNamed(`${tenant.name}-x-y`)).toBeUndefined();
      expect((await rowsOf(admin)).map((row) => row.name)).not.toContain('x-y');
    });

    it('refuses a name whose gateway name a Built-in model provider holds, even without the Organization’s own row of it', async () => {
      const { tenant, admin } = await seededTenantNamed('custom');
      await db
        .delete(modelProviders)
        .where(
          and(eq(modelProviders.tenantId, tenant.tenantId), eq(modelProviders.bifrostProvider, 'custom-openai-1'))
        );
      bifrost.loseProvider('custom-openai-1');

      const res = await create(admin, officialKey({ name: 'openai-1' }));

      expect(res.statusCode).toBe(409);
      expect(res.json<{ message: string }>().message).toBe(NAME_TAKEN);
      expect(bifrost.providerNamed('custom-openai-1')).toBeUndefined();
    });

    it('refuses an 11th Custom model provider with a message', async () => {
      const { admin } = await seededTenant();
      for (let index = 1; index <= 10; index++) {
        const res = await create(admin, officialKey({ name: `key-${index}` }));
        expect(res.statusCode, res.body).toBe(201);
      }

      const eleventh = await create(admin, officialKey({ name: 'key-11' }));

      expect(eleventh.statusCode).toBe(409);
      expect(eleventh.json<{ message: string }>().message).toBe(
        'An organization can have at most 10 Custom model providers; delete one to add another'
      );
      const rules = await app.inject({
        method: 'GET',
        url: '/api/model-providers/creation-rules',
        headers: admin.headers,
      });
      expect(rules.json<{ customProviderCount: number }>().customProviderCount).toBe(10);
    });
  });

  describe('after saving', () => {
    it('never shows the key again and lists the Custom row with its kind, Built-in rows without one', async () => {
      const { admin } = await seededTenant();
      await create(admin, officialKey({ key: 'sk-live-never-shown-again' }));

      const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });

      expect(res.body).not.toContain('sk-live-never-shown-again');
      expect(res.json<ModelProvidersView>().providers).toEqual([
        { name: 'anthropic', baseFormat: 'anthropic', enabled: true, weight: 1, status: 'working' },
        { name: 'custom-openai-1', baseFormat: 'openai', enabled: true, weight: 1, status: 'working' },
        { name: 'openai', baseFormat: 'openai', enabled: true, weight: 0, status: 'working' },
        {
          name: 'own-key',
          kind: 'official-api-key',
          baseFormat: 'openai',
          enabled: true,
          weight: 1,
          status: 'working',
        },
      ]);
    });

    it('refuses to add while Bifrost is unreachable', async () => {
      const { admin } = await seededTenant();
      bifrost.becomeUnreachable();

      const res = await create(admin, officialKey());

      expect(res.statusCode).toBe(503);
    });
  });

  describe('delete', () => {
    it('takes the row out of every chat key, deletes the Bifrost provider and confirms with a GET', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const bifrostName = `${tenant.name}-own-key`;
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      const chatKeyId = bifrost.chatKeyOf(projectId).id;
      const writesBefore = bifrost.requests.length;

      const res = await app.inject({ method: 'DELETE', url: '/api/model-providers/own-key', headers: admin.headers });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<ModelProvidersView>().providers.map((row) => row.name)).not.toContain('own-key');
      expect(bifrost.providerNamed(bifrostName)).toBeUndefined();
      expect(bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider)).toEqual([
        'anthropic',
        'custom-openai-1',
        'openai',
      ]);
      const calls = bifrost.requests
        .slice(writesBefore)
        .filter(
          (request) =>
            request.path === `/api/providers/${bifrostName}` ||
            request.path === `/api/governance/virtual-keys/${chatKeyId}`
        )
        .map((request) => request.method);
      expect(calls).toEqual(['PUT', 'DELETE', 'GET']);
    });

    it('keeps the row and fails when Bifrost answers the delete but keeps the provider', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const bifrostName = `${tenant.name}-own-key`;
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      bifrost.keepProvidersOnDelete();

      const res = await app.inject({ method: 'DELETE', url: '/api/model-providers/own-key', headers: admin.headers });

      expect(res.statusCode).toBe(502);
      expect((await rowsOf(admin)).map((row) => row.name)).toContain('own-key');
      expect(bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider)).toContain(bifrostName);
    });

    it('refuses to delete a Built-in row and an unknown name', async () => {
      const { admin } = await seededTenant();

      const builtIn = await app.inject({
        method: 'DELETE',
        url: '/api/model-providers/openai',
        headers: admin.headers,
      });
      const unknown = await app.inject({
        method: 'DELETE',
        url: '/api/model-providers/nobody',
        headers: admin.headers,
      });

      expect(builtIn.statusCode).toBe(400);
      expect(builtIn.json<{ message: string }>().message).toBe('Built-in model providers can’t be deleted');
      expect(unknown.statusCode).toBe(404);
      expect((await rowsOf(admin)).map((row) => row.name)).toContain('openai');
      expect(bifrost.providerNamed('openai')).toBeDefined();
    });

    it('does not reach another Organization’s provider of the same name', async () => {
      const first = await seededTenant();
      const second = await seededTenant();
      expect((await create(first.admin, officialKey())).statusCode).toBe(201);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/model-providers/own-key',
        headers: second.admin.headers,
      });

      expect(res.statusCode).toBe(404);
      expect(bifrost.providerNamed(`${first.tenant.name}-own-key`)).toBeDefined();
    });
  });

  describe('another Organization’s provider behind the same gateway name', () => {
    it('can’t be edited or deleted by the Organization whose name prefixes it', async () => {
      const { tenant, admin } = await seededTenant();
      const neighbour = await seededTenantNamed(`${tenant.name}-x`);
      expect((await create(neighbour.admin, officialKey({ name: 'y' }))).statusCode).toBe(201);

      const edited = await app.inject({
        method: 'PATCH',
        url: '/api/model-providers/x-y',
        headers: admin.headers,
        payload: { key: 'sk-live-other' },
      });
      const deleted = await app.inject({ method: 'DELETE', url: '/api/model-providers/x-y', headers: admin.headers });

      expect([edited.statusCode, deleted.statusCode]).toEqual([404, 404]);
      expect(bifrost.providerNamed(`${tenant.name}-x-y`)?.keys).toHaveLength(1);
      expect((await rowsOf(neighbour.admin)).map((row) => row.name)).toContain('y');
    });
  });

  describe('who may use it', () => {
    it('refuses a member without can_manage_tenant_model_providers on every route', async () => {
      const { tenant, admin } = await seededTenant();
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      const member = await addMember(app, tenant, [Perms.manageTenantBudget, Perms.manageTenantDefaults]);

      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/api/model-providers/creation-rules', headers: member.headers }),
        testConnection(member, officialKey({ name: 'other' })),
        create(member, officialKey({ name: 'other' })),
        app.inject({ method: 'DELETE', url: '/api/model-providers/own-key', headers: member.headers }),
        app.inject({
          method: 'PATCH',
          url: '/api/model-providers/own-key',
          headers: member.headers,
          payload: { key: 'sk-live-2' },
        }),
        app.inject({
          method: 'POST',
          url: '/api/model-providers/own-key/re-enter-key',
          headers: member.headers,
          payload: officialKey(),
        }),
      ]);

      expect(responses.map((res) => res.statusCode)).toEqual([403, 403, 403, 403, 403, 403]);
      expect((await rowsOf(admin)).map((row) => row.name)).toContain('own-key');
    });
  });

  describe('the Bifrost provider it creates', () => {
    it('is named after the Organization, keeps list_models off and uses native Responses for OpenAI', async () => {
      const { tenant, admin } = await seededTenant();

      const res = await create(admin, officialKey({ name: 'openai-own' }));

      expect(res.statusCode, res.body).toBe(201);
      const provider = bifrost.providerNamed(`${tenant.name}-openai-own`);
      expect(provider?.created).toEqual({
        provider: `${tenant.name}-openai-own`,
        network_config: {
          default_request_timeout_in_seconds: 1200,
          max_retries: 2,
          retry_backoff_initial: 500,
          retry_backoff_max: 5000,
          stream_idle_timeout_in_seconds: 3600,
        },
        concurrency_and_buffer_size: { concurrency: 20, buffer_size: 200 },
        custom_provider_config: {
          base_provider_type: 'openai',
          is_key_less: false,
          allowed_requests: {
            list_models: false,
            chat_completion: true,
            chat_completion_stream: true,
            responses: true,
            responses_stream: true,
            count_tokens: false,
          },
        },
      });
      expect(provider?.keys).toEqual([
        {
          id: expect.any(String),
          name: `${tenant.name}-openai-own-key`,
          value: { value: 'sk-live-own', type: 'plain_text' },
          models: OPENAI_CATALOG_IDS,
          weight: 1,
          enabled: true,
        },
      ]);
    });

    it('carries the Anthropic catalog on an Anthropic-format key, sent as plain text even when it looks like an env reference', async () => {
      const { tenant, admin } = await seededTenant();

      const res = await create(
        admin,
        officialKey({ baseFormat: 'anthropic', name: 'claude-own', key: 'env.ANTHROPIC_API_KEY' })
      );

      expect(res.statusCode, res.body).toBe(201);
      const provider = bifrost.providerNamed(`${tenant.name}-claude-own`);
      expect(provider?.created).toMatchObject({
        custom_provider_config: { base_provider_type: 'anthropic', allowed_requests: { list_models: false } },
      });
      expect(provider?.keys).toMatchObject([
        { value: { value: 'env.ANTHROPIC_API_KEY', type: 'plain_text' }, models: ANTHROPIC_CATALOG_IDS },
      ]);
      expect(vendor.requests.at(-1)?.headers).toMatchObject({
        'x-api-key': 'env.ANTHROPIC_API_KEY',
        'anthropic-version': '2023-06-01',
      });
      expect(res.json<ModelProvidersView>().providers).toContainEqual({
        name: 'claude-own',
        kind: 'official-api-key',
        baseFormat: 'anthropic',
        enabled: true,
        weight: 1,
        status: 'working',
      });
    });
  });
  describe('a Compatible endpoint', () => {
    function compatible(overrides: Partial<NewProvider> = {}): NewProvider {
      return {
        baseFormat: 'openai',
        kind: 'compatible-endpoint',
        name: 'gateway',
        key: 'sk-gateway',
        baseUrl: `${gatewayUrl}/`,
        ...overrides,
      };
    }

    it('tests the key against the typed base URL and creates the provider translated to Chat Completions', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const bifrostName = `${tenant.name}-gateway`;

      const res = await create(admin, compatible());

      expect(res.statusCode, res.body).toBe(201);
      const provider = bifrost.providerNamed(bifrostName);
      expect(provider?.created).toEqual({
        provider: bifrostName,
        network_config: {
          default_request_timeout_in_seconds: 1200,
          max_retries: 2,
          retry_backoff_initial: 500,
          retry_backoff_max: 5000,
          stream_idle_timeout_in_seconds: 3600,
          base_url: gatewayUrl,
          allow_private_network: false,
        },
        concurrency_and_buffer_size: { concurrency: 20, buffer_size: 200 },
        custom_provider_config: {
          base_provider_type: 'openai',
          is_key_less: false,
          allowed_requests: {
            list_models: false,
            chat_completion: true,
            chat_completion_stream: true,
            responses: false,
            responses_stream: false,
            count_tokens: false,
          },
          request_path_overrides: OPENAI_COMPATIBLE_PATHS,
        },
      });
      expect(provider?.keys).toMatchObject([
        { value: { value: 'sk-gateway', type: 'plain_text' }, models: OPENAI_CATALOG_IDS },
      ]);
      expect(vendor.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' });
      expect(vendor.requests.at(-1)?.headers.authorization).toBe('Bearer sk-gateway');
      expect(res.json<ModelProvidersView>().providers).toContainEqual({
        name: 'gateway',
        kind: 'compatible-endpoint',
        baseUrl: gatewayUrl,
        baseFormat: 'openai',
        enabled: true,
        weight: 1,
        status: 'working',
      });
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: bifrostName,
        weight: 1,
        ...CATALOG_WIDE,
      });
    });

    it('keeps the Anthropic format native on a Compatible endpoint', async () => {
      const { tenant, admin } = await seededTenant();

      const res = await create(
        admin,
        compatible({ baseFormat: 'anthropic', name: 'claude-gateway', baseUrl: 'https://gateway.example.test' })
      );

      expect(res.statusCode, res.body).toBe(201);
      const created = bifrost.providerNamed(`${tenant.name}-claude-gateway`)?.created as {
        custom_provider_config: Record<string, unknown>;
      };
      expect(created.custom_provider_config).toEqual({
        base_provider_type: 'anthropic',
        is_key_less: false,
        allowed_requests: {
          list_models: false,
          chat_completion: true,
          chat_completion_stream: true,
          responses: true,
          responses_stream: true,
          count_tokens: true,
        },
      });
      expect(vendor.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' });
      expect(vendor.requests.at(-1)?.headers['x-api-key']).toBe('sk-gateway');
    });

    it.each([
      ['plain http', 'http://gateway.example.test/v1'],
      ['another scheme', 'ftp://gateway.example.test/v1'],
      ['text that is not a URL', 'gateway.example.test'],
    ])('refuses %s before touching Bifrost', async (_label, baseUrl) => {
      const { tenant, admin } = await seededTenant();

      const res = await create(admin, compatible({ baseUrl }));
      const tested = await testConnection(admin, compatible({ baseUrl }));

      for (const response of [res, tested]) {
        expect(response.statusCode).toBe(400);
        expect(response.json<{ message: string }>().message).toBe('Enter an https:// base URL');
      }
      expect(bifrost.requests.some((request) => request.path.includes(`${tenant.name}-gateway`))).toBe(false);
    });

    it('refuses a missing base URL', async () => {
      const { admin } = await seededTenant();

      const res = await create(admin, compatible({ baseUrl: undefined }));

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe('Enter an https:// base URL');
    });

    it('shows Bifrost’s own refusal of a private address as is', async () => {
      const { tenant, admin } = await seededTenant();

      const res = await create(admin, compatible({ baseUrl: 'https://10.1.2.3/v1' }));

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe('Invalid base URL: 10.1.2.3 is a private network address');
      expect(bifrost.providerNamed(`${tenant.name}-gateway`)).toBeUndefined();
      expect((await rowsOf(admin)).map((row) => row.name)).not.toContain('gateway');
    });

    it('fails a redirecting endpoint with “Enter the final URL” and rolls the provider back', async () => {
      const { tenant, admin } = await seededTenant();
      vendor.replyWith('redirect');

      const res = await create(admin, compatible());

      expect(res.statusCode).toBe(422);
      expect(res.json<{ message: string }>().message).toBe('Enter the final URL');
      expect(vendor.requests.some((request) => request.path === REDIRECT_TARGET_PATH)).toBe(false);
      expect(bifrost.providerNamed(`${tenant.name}-gateway`)).toBeUndefined();
    });

    it('refuses a base URL on an Official API key', async () => {
      const { admin } = await seededTenant();

      const res = await create(admin, officialKey({ baseUrl: gatewayUrl }));

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe('An Official API key has no base URL');
    });
  });

  describe('edit connection', () => {
    const movedUrl = () => `${gatewayUrl.replace(/\/v1$/, '')}/moved/v1`;

    function compatible(overrides: Partial<NewProvider> = {}): NewProvider {
      return {
        baseFormat: 'openai',
        kind: 'compatible-endpoint',
        name: 'gateway',
        key: 'sk-gateway',
        baseUrl: gatewayUrl,
        ...overrides,
      };
    }

    function edit(admin: MemberFixture, name: string, payload: Record<string, unknown>) {
      return app.inject({
        method: 'PATCH',
        url: `/api/model-providers/${name}`,
        headers: admin.headers,
        payload,
      });
    }

    function storedKeyOf(bifrostName: string) {
      return bifrost.providerNamed(bifrostName)?.keys;
    }

    it('re-tests a replacement key and swaps it in place without ever returning a key', async () => {
      const { tenant, admin } = await seededTenant();
      const bifrostName = `${tenant.name}-own-key`;
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      const [original] = storedKeyOf(bifrostName) ?? [];

      const res = await edit(admin, 'own-key', { key: 'sk-live-replaced' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('sk-live');
      expect(vendor.requests.at(-1)?.headers.authorization).toBe('Bearer sk-live-replaced');
      expect(storedKeyOf(bifrostName)).toEqual([
        { ...original, value: { value: 'sk-live-replaced', type: 'plain_text' } },
      ]);
      expect(bifrost.writes.at(-1)).toMatchObject({
        method: 'PUT',
        path: `/api/providers/${bifrostName}/keys/${original?.id}`,
      });
    });

    it('keeps the old key when the replacement fails its test', async () => {
      const { tenant, admin } = await seededTenant();
      const bifrostName = `${tenant.name}-own-key`;
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      const before = storedKeyOf(bifrostName);
      vendor.replyWith(401);

      const res = await edit(admin, 'own-key', { key: 'sk-live-rejected' });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ message: string }>().message).toBe('The key was rejected');
      expect(storedKeyOf(bifrostName)).toEqual(before);
    });

    it('moves a Compatible endpoint to a new base URL after the new address passes its test', async () => {
      const { tenant, admin } = await seededTenant();
      const bifrostName = `${tenant.name}-gateway`;
      expect((await create(admin, compatible())).statusCode).toBe(201);

      const res = await edit(admin, 'gateway', { baseUrl: movedUrl(), key: 'sk-gateway-2' });

      expect(res.statusCode, res.body).toBe(200);
      expect(vendor.requests.at(-1)).toMatchObject({ method: 'GET', path: '/moved/v1/models' });
      const provider = bifrost.providerNamed(bifrostName);
      expect(provider?.baseUrl).toBe(movedUrl());
      expect(provider?.updated).toMatchObject({
        network_config: { base_url: movedUrl(), allow_private_network: false },
        custom_provider_config: {
          base_provider_type: 'openai',
          allowed_requests: { responses: false },
          request_path_overrides: OPENAI_COMPATIBLE_PATHS,
        },
      });
      expect(provider?.updated).not.toHaveProperty('proxy_config');
      expect(provider?.keys).toMatchObject([{ value: { value: 'sk-gateway-2', type: 'plain_text' } }]);
      expect(res.json<ModelProvidersView>().providers).toContainEqual(
        expect.objectContaining({ name: 'gateway', baseUrl: movedUrl() })
      );
    });

    it('puts the old base URL and key back when the new address fails its test', async () => {
      const { tenant, admin } = await seededTenant();
      const bifrostName = `${tenant.name}-gateway`;
      expect((await create(admin, compatible())).statusCode).toBe(201);
      const keysBefore = storedKeyOf(bifrostName);
      vendor.replyWith('drop');

      const res = await edit(admin, 'gateway', { baseUrl: movedUrl(), key: 'sk-gateway-2' });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ message: string }>().message).toBe("Can't reach this address");
      expect(bifrost.providerNamed(bifrostName)?.baseUrl).toBe(gatewayUrl);
      expect(storedKeyOf(bifrostName)).toEqual(keysBefore);
    });

    it('shows Bifrost’s refusal of a new private address and leaves the provider alone', async () => {
      const { tenant, admin } = await seededTenant();
      const bifrostName = `${tenant.name}-gateway`;
      expect((await create(admin, compatible())).statusCode).toBe(201);

      const res = await edit(admin, 'gateway', { baseUrl: 'https://192.168.1.20/v1', key: 'sk-gateway-2' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe(
        'Invalid base URL: 192.168.1.20 is a private network address'
      );
      expect(bifrost.providerNamed(bifrostName)?.baseUrl).toBe(gatewayUrl);
    });

    it('refuses a plain-http base URL before touching Bifrost', async () => {
      const { tenant, admin } = await seededTenant();
      expect((await create(admin, compatible())).statusCode).toBe(201);
      const writesBefore = bifrost.writes.length;

      const res = await edit(admin, 'gateway', { baseUrl: 'http://gateway.example.test/v1', key: 'sk-gateway-2' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe('Enter an https:// base URL');
      expect(bifrost.writes.slice(writesBefore)).toEqual([]);
      expect(bifrost.providerNamed(`${tenant.name}-gateway`)?.baseUrl).toBe(gatewayUrl);
    });

    it.each([
      ['the name', { name: 'renamed' }],
      ['the Base format', { baseFormat: 'anthropic' }],
      ['the kind', { kind: 'official-api-key' }],
    ])('refuses to change %s', async (_label, change) => {
      const { admin } = await seededTenant();
      expect((await create(admin, compatible())).statusCode).toBe(201);

      const res = await edit(admin, 'gateway', { key: 'sk-gateway-2', ...change });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe('The name and Base format of a model provider are fixed');
    });

    it('asks for the key, which a re-test needs, and refuses a base URL on an Official API key', async () => {
      const { admin } = await seededTenant();
      expect((await create(admin, officialKey())).statusCode).toBe(201);

      const noKey = await edit(admin, 'own-key', {});
      const withUrl = await edit(admin, 'own-key', { key: 'sk-live-2', baseUrl: gatewayUrl });

      expect(noKey.statusCode).toBe(400);
      expect(noKey.json<{ message: string }>().message).toBe('Enter the key');
      expect(withUrl.statusCode).toBe(400);
      expect(withUrl.json<{ message: string }>().message).toBe('An Official API key has no base URL');
    });

    it('refuses Built-in rows, unknown names and a provider the gateway lost', async () => {
      const { tenant, admin } = await seededTenant();
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      bifrost.loseProvider(`${tenant.name}-own-key`);

      const builtIn = await edit(admin, 'openai', { key: 'sk-live-2' });
      const unknown = await edit(admin, 'nobody', { key: 'sk-live-2' });
      const lost = await edit(admin, 'own-key', { key: 'sk-live-2' });

      expect(builtIn.statusCode).toBe(400);
      expect(builtIn.json<{ message: string }>().message).toBe('Built-in model providers can’t be edited');
      expect(unknown.statusCode).toBe(404);
      expect(lost.statusCode).toBe(409);
      expect(lost.json<{ message: string }>().message).toBe(
        'The model gateway no longer has own-key; re-enter its key instead'
      );
      expect(bifrost.providerNamed(`${tenant.name}-own-key`)).toBeUndefined();
    });
  });

  describe('re-enter key', () => {
    function reenter(admin: MemberFixture, name: string, payload: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: `/api/model-providers/${name}/re-enter-key`,
        headers: admin.headers,
        payload,
      });
    }

    async function switchAndWeigh(admin: MemberFixture, providers: Array<Record<string, unknown>>) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: admin.headers,
        payload: { providers },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    it('keeps a lost provider out of traffic, then restores it under the same name with its switch and weight', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const bifrostName = `${tenant.name}-gateway`;
      const created = await create(admin, {
        baseFormat: 'openai',
        kind: 'compatible-endpoint',
        name: 'gateway',
        key: 'sk-gateway',
        baseUrl: gatewayUrl,
      });
      expect(created.statusCode, created.body).toBe(201);
      await switchAndWeigh(admin, [{ name: 'gateway', enabled: true, weight: 7 }]);
      bifrost.loseProvider(bifrostName);
      await switchAndWeigh(admin, [{ name: 'openai', enabled: true, weight: 2 }]);

      expect(bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider)).not.toContain(bifrostName);
      expect((await rowsOf(admin)).find((row) => row.name === 'gateway')).toEqual({
        name: 'gateway',
        kind: null,
        baseFormat: null,
        enabled: true,
        weight: 7,
        status: 'missing',
      });

      const res = await reenter(admin, 'gateway', {
        baseFormat: 'openai',
        kind: 'compatible-endpoint',
        key: 'sk-gateway-again',
        baseUrl: gatewayUrl,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(bifrost.providerNamed(bifrostName)?.keys).toMatchObject([
        { value: { value: 'sk-gateway-again', type: 'plain_text' } },
      ]);
      expect(res.json<ModelProvidersView>().providers.find((row) => row.name === 'gateway')).toEqual({
        name: 'gateway',
        kind: 'compatible-endpoint',
        baseUrl: gatewayUrl,
        baseFormat: 'openai',
        enabled: true,
        weight: 7,
        status: 'working',
      });
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: bifrostName,
        weight: 7,
        ...CATALOG_WIDE,
      });
    });

    it('leaves the row missing and out of traffic when the re-entered key fails its test', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const bifrostName = `${tenant.name}-own-key`;
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      bifrost.loseProvider(bifrostName);
      vendor.replyWith(401);

      const res = await reenter(admin, 'own-key', { baseFormat: 'openai', kind: 'official-api-key', key: 'sk-bad' });

      expect(res.statusCode).toBe(422);
      expect(bifrost.providerNamed(bifrostName)).toBeUndefined();
      expect((await rowsOf(admin)).find((row) => row.name === 'own-key')?.status).toBe('missing');
      expect(bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider)).not.toContain(bifrostName);
    });

    it('refuses a provider the gateway still has, a Built-in row and an unknown name', async () => {
      const { admin } = await seededTenant();
      expect((await create(admin, officialKey())).statusCode).toBe(201);
      const payload = { baseFormat: 'openai', kind: 'official-api-key', key: 'sk-live-2' };

      const present = await reenter(admin, 'own-key', payload);
      const builtIn = await reenter(admin, 'openai', payload);
      const unknown = await reenter(admin, 'nobody', payload);

      expect(present.statusCode).toBe(409);
      expect(present.json<{ message: string }>().message).toBe(
        'The model gateway still has own-key; edit its connection instead'
      );
      expect(builtIn.statusCode).toBe(400);
      expect(builtIn.json<{ message: string }>().message).toBe('Built-in model providers can’t be edited');
      expect(unknown.statusCode).toBe(404);
    });
  });
});
