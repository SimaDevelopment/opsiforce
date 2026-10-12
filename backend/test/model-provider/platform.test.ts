import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { modelProviders, projectVirtualKeys, tenants } from '../../db/schema';
import { catalogModelIdsOf } from '../../src/agent/agent-models';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { TenantController } from '../../src/tenant/tenant.controller';
import { seedLiveAgent } from '../support/agent-fixtures';
import { DOCK_BASE_URL, startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { startFakeVendorApi, type FakeVendorApi } from './support/fake-vendor-api';
import {
  addMember,
  createAgent,
  createProject,
  createTenant,
  serviceKeyFor,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { proxyHeaders } from '../support/proxy-identity';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const OPENAI_CATALOG_IDS = catalogModelIdsOf('openai');
const ANTHROPIC_CATALOG_IDS = catalogModelIdsOf('anthropic');

interface BuiltInRow {
  name: string;
  baseFormat: string | null;
  kind: string | null;
  url: string | null;
  status: string;
  fixed: boolean;
  notMetered: boolean;
  linkedAccountVendor?: string;
}

interface BuiltInView {
  bifrostReachable: boolean;
  providers: BuiltInRow[];
}

const FIXED_OPENAI: BuiltInRow = {
  name: 'openai',
  baseFormat: 'openai',
  kind: 'official-api-key',
  url: 'https://api.openai.com/v1',
  status: 'working',
  fixed: true,
  notMetered: false,
};

const FIXED_ANTHROPIC: BuiltInRow = {
  name: 'anthropic',
  baseFormat: 'anthropic',
  kind: 'official-api-key',
  url: 'https://api.anthropic.com/v1',
  status: 'working',
  fixed: true,
  notMetered: false,
};

const DOCK: BuiltInRow = {
  name: 'custom-openai-1',
  baseFormat: 'openai',
  kind: 'linked-account',
  url: DOCK_BASE_URL,
  status: 'working',
  fixed: false,
  notMetered: false,
  linkedAccountVendor: 'chatgpt',
};

function officialKey(overrides: Record<string, unknown> = {}) {
  return { baseFormat: 'openai', kind: 'official-api-key', name: 'extra', key: 'sk-extra', ...overrides };
}

async function everyChatKeyId(): Promise<string[]> {
  const keys = await db
    .select({ id: projectVirtualKeys.bifrostKeyId })
    .from(projectVirtualKeys)
    .where(eq(projectVirtualKeys.keyType, 'chat'));
  return keys.map((key) => key.id);
}

@Module({ controllers: [TenantController] })
class TenantRoutes {}

describe('Built-in model providers managed by a platform admin', () => {
  let bifrost: FakeBifrost;
  let vendor: FakeVendorApi;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;
  let gatewayUrl: string;
  let otherGatewayUrl: string;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    vendor = await startFakeVendorApi();
    gatewayUrl = vendor.servedOverHttpsAt('platform-gateway.example.test');
    otherGatewayUrl = vendor.servedOverHttpsAt('platform-gateway-2.example.test');
    harness = await createPublicApiTestApp(
      {
        ...bifrost.env,
        MODEL_PROVIDER_OFFICIAL_API_URLS: JSON.stringify({ openai: vendor.baseUrl, anthropic: vendor.baseUrl }),
      },
      [ModelProvidersModule, TenantRoutes],
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

  async function member(permissions: string[]): Promise<{ tenant: TenantFixture; member: MemberFixture }> {
    const tenant = await createTenant(app);
    return { tenant, member: await addMember(app, tenant, permissions) };
  }

  async function platformAdmin(): Promise<MemberFixture> {
    return (await member([Perms.managePlatformModelProviders])).member;
  }

  async function orgAdmin(): Promise<{ tenant: TenantFixture; member: MemberFixture }> {
    return member([Perms.manageTenantModelProviders]);
  }

  function saveAnthropic(admin: MemberFixture, weight: number) {
    return app.inject({
      method: 'PUT',
      url: '/api/model-providers/formats/anthropic',
      headers: admin.headers,
      payload: { providers: [{ name: 'anthropic', enabled: true, weight }] },
    });
  }

  async function anthropicOf(admin: MemberFixture): Promise<{ enabled: boolean; weight: number } | undefined> {
    const page = await app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });
    const row = page
      .json<{ providers: Array<{ name: string; enabled: boolean; weight: number }> }>()
      .providers.find((provider) => provider.name === 'anthropic');
    return row && { enabled: row.enabled, weight: row.weight };
  }

  async function ownRowsOf(tenant: TenantFixture) {
    return db
      .select({ bifrostProvider: modelProviders.bifrostProvider })
      .from(modelProviders)
      .where(eq(modelProviders.tenantId, tenant.tenantId));
  }

  function list(admin: MemberFixture) {
    return app.inject({ method: 'GET', url: '/api/platform-model-providers', headers: admin.headers });
  }

  function editConnection(admin: MemberFixture, name: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api/platform-model-providers/${name}`,
      headers: admin.headers,
      payload,
    });
  }

  async function projectOf(tenant: TenantFixture): Promise<string> {
    const owner = await addMember(app, tenant);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: owner.headers,
      payload: { title: 'Routed', agentId },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function rowsOf(admin: MemberFixture): Promise<BuiltInRow[]> {
    const res = await list(admin);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<BuiltInView>().providers;
  }

  describe('listing', () => {
    it('shows every platform provider with its format, how it connects, its URL and its status', async () => {
      const admin = await platformAdmin();

      const res = await list(admin);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<BuiltInView>()).toEqual({
        bifrostReachable: true,
        providers: [FIXED_ANTHROPIC, DOCK, FIXED_OPENAI],
      });
    });

    it('shows a platform provider missing from Bifrost as missing', async () => {
      const admin = await platformAdmin();
      bifrost.setProviders(['openai', 'custom-openai-1']);

      expect(await rowsOf(admin)).toContainEqual({ ...FIXED_ANTHROPIC, status: 'missing' });
    });

    it('leaves a platform provider missing from Bifrost out of every chat key it syncs', async () => {
      const { tenant, member: orgAdmin } = await member([Perms.manageTenantModelProviders]);
      const projectId = await projectOf(tenant);
      bifrost.setProviders(['openai', 'custom-openai-1']);

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: orgAdmin.headers,
        payload: { providers: [{ name: 'openai', enabled: true, weight: 0 }] },
      });

      expect(saved.statusCode, saved.body).toBe(200);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
        { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
        { provider: 'openai', weight: 0, ...CATALOG_WIDE },
      ]);
    });
  });

  describe('the fixed openai and anthropic', () => {
    it('replace their key after a passing test and keep serving every model', async () => {
      const admin = await platformAdmin();

      const res = await editConnection(admin, 'openai', { key: 'sk-platform-new' });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<BuiltInView>().providers).toContainEqual(FIXED_OPENAI);
      expect(res.body).not.toContain('sk-platform-new');
      expect(bifrost.providerNamed('openai')?.keys).toEqual([
        {
          id: expect.any(String),
          name: 'openai-key',
          value: { value: 'sk-platform-new', type: 'plain_text' },
          models: ['*'],
          weight: 1,
          enabled: true,
        },
      ]);
      expect(vendor.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' });
      expect(vendor.requests.at(-1)?.headers.authorization).toBe('Bearer sk-platform-new');
    });

    it('keep their current key when the new one fails its test', async () => {
      const admin = await platformAdmin();
      vendor.replyWith(401);

      const res = await editConnection(admin, 'anthropic', { key: 'sk-ant-wrong' });

      expect(res.statusCode).toBe(422);
      expect(res.json<{ message: string }>().message).toBe('The key was rejected');
      expect(bifrost.providerNamed('anthropic')?.keys).toEqual([]);
    });

    it('never take a base URL and can’t be deleted', async () => {
      const admin = await platformAdmin();

      const moved = await editConnection(admin, 'openai', { key: 'sk-new', baseUrl: 'https://gateway.example.test' });
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/platform-model-providers/anthropic',
        headers: admin.headers,
      });

      expect(moved.statusCode).toBe(400);
      expect(moved.json<{ message: string }>().message).toBe(
        'The built-in openai and anthropic always point at the vendor’s API; only their key can change'
      );
      expect(deleted.statusCode).toBe(400);
      expect(deleted.json<{ message: string }>().message).toBe(
        'The built-in openai and anthropic can’t be deleted: transcription and apps depend on them'
      );
      expect(bifrost.providerNamed('anthropic')).toBeDefined();
      expect(bifrost.providerNamed('openai')?.updated).toBeNull();
    });

    it('come back under the same name when re-keyed after the gateway lost one, back in every Organization’s chat keys', async () => {
      const admin = await platformAdmin();
      const { tenant } = await member([]);
      const projectId = await projectOf(tenant);
      bifrost.holdVirtualKeys(await everyChatKeyId());
      bifrost.loseProvider('anthropic');
      expect(bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider)).not.toContain('anthropic');

      const res = await app.inject({
        method: 'POST',
        url: '/api/platform-model-providers/anthropic/re-enter-key',
        headers: admin.headers,
        payload: { baseFormat: 'anthropic', kind: 'official-api-key', key: 'sk-ant-restored' },
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<BuiltInView>().providers).toContainEqual(FIXED_ANTHROPIC);
      expect(bifrost.providerNamed('anthropic')?.created).toEqual({
        provider: 'anthropic',
        network_config: {
          default_request_timeout_in_seconds: 1200,
          max_retries: 2,
          retry_backoff_initial: 500,
          retry_backoff_max: 5000,
          stream_idle_timeout_in_seconds: 3600,
        },
      });
      expect(bifrost.providerNamed('anthropic')?.keys).toMatchObject([
        { value: { value: 'sk-ant-restored', type: 'plain_text' }, models: ['*'] },
      ]);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: 'anthropic',
        weight: 1,
        ...CATALOG_WIDE,
      });
    });

    it('re-enter only as their own format with an Official API key', async () => {
      const admin = await platformAdmin();
      bifrost.loseProvider('openai');

      const responses = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/platform-model-providers/openai/re-enter-key',
          headers: admin.headers,
          payload: { baseFormat: 'anthropic', kind: 'official-api-key', key: 'sk-x' },
        }),
        app.inject({
          method: 'POST',
          url: '/api/platform-model-providers/openai/re-enter-key',
          headers: admin.headers,
          payload: {
            baseFormat: 'openai',
            kind: 'compatible-endpoint',
            key: 'sk-x',
            baseUrl: 'https://gateway.example.test',
          },
        }),
      ]);

      expect(responses.map((res) => res.statusCode)).toEqual([400, 400]);
      expect(bifrost.providerNamed('openai')).toBeUndefined();
    });
  });

  describe('opsiforce-* providers', () => {
    async function create(admin: MemberFixture, payload: Record<string, unknown>) {
      bifrost.holdVirtualKeys(await everyChatKeyId());
      return app.inject({ method: 'POST', url: '/api/platform-model-providers', headers: admin.headers, payload });
    }

    function remove(admin: MemberFixture, name: string) {
      return app.inject({ method: 'DELETE', url: `/api/platform-model-providers/${name}`, headers: admin.headers });
    }

    async function tenantRowNames(tenant: TenantFixture): Promise<string[]> {
      const orgAdmin = await addMember(app, tenant, [Perms.manageTenantModelProviders]);
      const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: orgAdmin.headers });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ providers: Array<{ name: string }> }>().providers.map((row) => row.name);
    }

    it('tells the dialog the opsiforce- prefix, the computed name limit and the kinds it can add', async () => {
      const admin = await platformAdmin();

      const res = await app.inject({
        method: 'GET',
        url: '/api/platform-model-providers/creation-rules',
        headers: admin.headers,
      });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        namePrefix: 'opsiforce-',
        nameMaxLength: 40,
        kindsByFormat: {
          openai: ['official-api-key', 'compatible-endpoint', 'linked-account'],
          anthropic: ['official-api-key', 'compatible-endpoint'],
        },
      });
    });

    it('are tested first, then created unmetered with the Base format’s catalog, and switched off in every Organization', async () => {
      const admin = await platformAdmin();
      const { tenant: existing } = await member([]);

      const tested = await app.inject({
        method: 'POST',
        url: '/api/platform-model-providers/test',
        headers: admin.headers,
        payload: officialKey(),
      });
      expect(tested.statusCode, tested.body).toBe(200);
      expect(bifrost.providerNamed('opsiforce-extra')).toBeUndefined();

      const res = await create(admin, officialKey());

      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<BuiltInView>().providers).toContainEqual({
        name: 'opsiforce-extra',
        baseFormat: 'openai',
        kind: 'official-api-key',
        url: 'https://api.openai.com/v1',
        status: 'working',
        fixed: false,
        notMetered: true,
      });
      expect(bifrost.providerNamed('opsiforce-extra')?.created).toMatchObject({
        provider: 'opsiforce-extra',
        custom_provider_config: { base_provider_type: 'openai', allowed_requests: { list_models: false } },
      });
      expect(bifrost.providerNamed('opsiforce-extra')?.keys).toMatchObject([
        { value: { value: 'sk-extra', type: 'plain_text' }, models: OPENAI_CATALOG_IDS },
      ]);
      const { tenant: later } = await member([]);
      expect(await tenantRowNames(existing)).toContain('opsiforce-extra');
      expect(await tenantRowNames(later)).toContain('opsiforce-extra');
      await remove(admin, 'opsiforce-extra');
    });

    it('connect a Compatible endpoint, move its URL and replace its key through the same test-first edit', async () => {
      const admin = await platformAdmin();
      const created = await create(admin, {
        baseFormat: 'anthropic',
        kind: 'compatible-endpoint',
        name: 'gateway',
        key: 'sk-gateway',
        baseUrl: `${gatewayUrl}/`,
      });
      expect(created.statusCode, created.body).toBe(201);

      const moved = await editConnection(admin, 'opsiforce-gateway', {
        key: 'sk-gateway-2',
        baseUrl: `${otherGatewayUrl}/`,
      });

      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json<BuiltInView>().providers).toContainEqual({
        name: 'opsiforce-gateway',
        baseFormat: 'anthropic',
        kind: 'compatible-endpoint',
        url: otherGatewayUrl,
        status: 'working',
        fixed: false,
        notMetered: true,
      });
      expect(bifrost.providerNamed('opsiforce-gateway')?.keys).toMatchObject([
        { value: { value: 'sk-gateway-2', type: 'plain_text' }, models: ANTHROPIC_CATALOG_IDS },
      ]);
      expect(vendor.requests.at(-1)?.headers['x-api-key']).toBe('sk-gateway-2');
      await remove(admin, 'opsiforce-gateway');
    });

    it('are deleted from the gateway, confirmed with a GET', async () => {
      const admin = await platformAdmin();
      expect((await create(admin, officialKey({ name: 'doomed' }))).statusCode).toBe(201);
      const before = bifrost.requests.length;

      const res = await remove(admin, 'opsiforce-doomed');

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<BuiltInView>().providers.map((row) => row.name)).not.toContain('opsiforce-doomed');
      expect(bifrost.providerNamed('opsiforce-doomed')).toBeUndefined();
      expect(
        bifrost.requests
          .slice(before)
          .filter((request) => request.path === '/api/providers/opsiforce-doomed')
          .map((request) => request.method)
      ).toEqual(['DELETE', 'GET']);
    });

    it('keep the row when the gateway answers the delete but keeps the provider', async () => {
      const admin = await platformAdmin();
      expect((await create(admin, officialKey({ name: 'sticky' }))).statusCode).toBe(201);
      bifrost.keepProvidersOnDelete();

      const res = await remove(admin, 'opsiforce-sticky');

      expect(res.statusCode).toBe(502);
      expect((await rowsOf(admin)).map((row) => row.name)).toContain('opsiforce-sticky');
      bifrost.deleteProvidersOnDelete();
      await remove(admin, 'opsiforce-sticky');
    });

    it('refuse a name already taken, a reserved name and one over the limit before touching Bifrost', async () => {
      const admin = await platformAdmin();
      expect((await create(admin, officialKey({ name: 'twice' }))).statusCode).toBe(201);

      const again = await create(admin, officialKey({ name: 'twice', baseFormat: 'anthropic' }));
      const reserved = await create(admin, officialKey({ name: 'bedrock-ish' }));
      const tooLong = await create(admin, officialKey({ name: 'a'.repeat(41) }));

      expect(again.statusCode).toBe(409);
      expect(again.json<{ message: string }>().message).toBe(
        'That name is taken by another Built-in model provider; choose another'
      );
      expect(reserved.statusCode).toBe(400);
      expect(tooLong.statusCode).toBe(400);
      expect(bifrost.providerNamed(`opsiforce-${'a'.repeat(41)}`)).toBeUndefined();
      await remove(admin, 'opsiforce-twice');
    });

    it('leave custom-openai-1 to its own management', async () => {
      const admin = await platformAdmin();

      const edited = await editConnection(admin, 'custom-openai-1', { key: 'sk-x' });
      const deleted = await remove(admin, 'custom-openai-1');

      expect([edited.statusCode, deleted.statusCode]).toEqual([400, 400]);
      expect(bifrost.providerNamed('custom-openai-1')).toBeDefined();
    });
  });

  describe('the opsiforce- prefix', () => {
    it.each(['opsiforce', 'opsiforce-foo'])('can’t be taken by an Organization named %s', async (name) => {
      const headers = proxyHeaders({ tenants: [name], permissions: [Perms.manageTenantModelProviders] });

      const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe(
        'An organization can’t be named opsiforce or start with opsiforce-: the name is reserved for the platform’s own model providers'
      );
      expect(await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, name))).toEqual([]);
    });

    it('still lets a member of opsiforce and another Organization list the other one', async () => {
      const other = await createTenant(app);
      const headers = proxyHeaders({ tenants: ['opsiforce', other.name] });

      const res = await app.inject({ method: 'GET', url: '/api/tenants', headers });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<Array<{ name: string }>>().map((tenant) => tenant.name)).toEqual([other.name]);
    });
  });

  describe('platform defaults', () => {
    it('reach every Organization that has not chosen its own value, and a key change leaves an Organization’s choice as it is', async () => {
      const admin = await platformAdmin();
      const { member: chose } = await orgAdmin();
      const { member: neverChose } = await orgAdmin();
      const saved = await saveAnthropic(chose, 7);
      expect(saved.statusCode, saved.body).toBe(200);
      await db
        .update(modelProviders)
        .set({ weight: 3 })
        .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, 'anthropic')));

      try {
        expect((await editConnection(admin, 'anthropic', { key: 'sk-ant-rotated' })).statusCode).toBe(200);
        const { member: later } = await orgAdmin();

        expect(await anthropicOf(chose)).toEqual({ enabled: true, weight: 7 });
        expect(await anthropicOf(neverChose)).toEqual({ enabled: true, weight: 3 });
        expect(await anthropicOf(later)).toEqual({ enabled: true, weight: 3 });
      } finally {
        await db
          .update(modelProviders)
          .set({ weight: 1 })
          .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, 'anthropic')));
      }
    });
  });

  describe('an Organization’s own rows', () => {
    it('hold only the platform providers it set apart from the platform value', async () => {
      const { tenant, member: admin } = await orgAdmin();
      expect(await ownRowsOf(tenant)).toEqual([]);

      expect((await saveAnthropic(admin, 7)).statusCode).toBe(200);
      expect(await ownRowsOf(tenant)).toEqual([{ bifrostProvider: 'anthropic' }]);

      expect((await saveAnthropic(admin, 1)).statusCode).toBe(200);
      expect(await ownRowsOf(tenant)).toEqual([]);
      expect(await anthropicOf(admin)).toEqual({ enabled: true, weight: 1 });
    });
  });

  describe('who may use it', () => {
    it('refuses every route without the platform permission, including to an Organization model-provider admin', async () => {
      const { member: orgAdmin } = await member([Perms.manageTenantModelProviders]);
      const { member: nobody } = await member([]);
      const provider = { baseFormat: 'openai', kind: 'official-api-key', name: 'sneaky', key: 'sk-x' };

      for (const caller of [orgAdmin, nobody]) {
        const responses = await Promise.all([
          list(caller),
          app.inject({ method: 'GET', url: '/api/platform-model-providers/creation-rules', headers: caller.headers }),
          app.inject({
            method: 'POST',
            url: '/api/platform-model-providers/test',
            headers: caller.headers,
            payload: provider,
          }),
          app.inject({
            method: 'POST',
            url: '/api/platform-model-providers',
            headers: caller.headers,
            payload: provider,
          }),
          editConnection(caller, 'openai', { key: 'sk-x' }),
          app.inject({
            method: 'POST',
            url: '/api/platform-model-providers/openai/re-enter-key',
            headers: caller.headers,
            payload: provider,
          }),
          app.inject({ method: 'DELETE', url: '/api/platform-model-providers/openai', headers: caller.headers }),
        ]);
        expect(responses.map((res) => res.statusCode)).toEqual([403, 403, 403, 403, 403, 403, 403]);
      }
      expect(bifrost.providerNamed('opsiforce-sneaky')).toBeUndefined();
      expect(bifrost.providerNamed('openai')?.keys).toEqual([]);
    });

    it('never lists an Organization’s own model providers to a platform admin', async () => {
      const admin = await platformAdmin();
      const { tenant, member: orgAdmin } = await member([Perms.manageTenantModelProviders]);
      const created = await app.inject({
        method: 'POST',
        url: '/api/model-providers',
        headers: orgAdmin.headers,
        payload: { baseFormat: 'openai', kind: 'official-api-key', name: 'own-key', key: 'sk-own' },
      });
      expect(created.statusCode, created.body).toBe(201);

      const res = await list(admin);

      expect(res.json<BuiltInView>().providers.map((row) => row.name)).toEqual([
        'anthropic',
        'custom-openai-1',
        'openai',
      ]);
      expect(res.body).not.toContain(tenant.name);
    });

    it('does not let the platform permission reach any Organization’s rows', async () => {
      const admin = await platformAdmin();

      const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });

      expect(res.statusCode).toBe(403);
    });

    it('refuses an Agent Caller', async () => {
      const { tenant, member: owner } = await member([Perms.managePlatformModelProviders]);
      const agent = await seedLiveAgent(tenant.tenantId, owner.userId);
      const callerProjectId = await createProject(app, tenant, { agentId: agent.id, createdBy: owner.userId });
      const callerKey = await serviceKeyFor(app, tenant, callerProjectId);

      const res = await app.inject({
        method: 'GET',
        url: '/api/platform-model-providers',
        headers: { ...owner.headers, authorization: `Bearer ${callerKey}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
