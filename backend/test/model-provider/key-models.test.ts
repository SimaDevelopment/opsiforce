import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { appliedModelCatalog, modelProviders, projectVirtualKeys } from '../../db/schema';
import { catalogModelIdsOf, readModelCatalog, type ModelCatalog } from '../../src/agent/agent-models';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProviderKeyModelsService } from '../../src/model-provider/model-provider-key-models.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { startFakeBifrost, type FakeBifrost, type FakeProviderKey } from '../support/fake-bifrost';
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
const OPENAI_CATALOG_IDS = catalogModelIdsOf('openai');
const NEXT_CATALOG: ModelCatalog = {
  openai: { models: { 'gpt-7': { experimental: { modes: { fast: {} } } }, 'gpt-6-astra': {} } },
  anthropic: { models: { 'claude-opus-6': {} } },
};
const NEXT_OPENAI_IDS = ['gpt-7', 'gpt-7-fast', 'gpt-6-astra'];

function staleKey(name: string, models: string[]): FakeProviderKey {
  return { id: `${name}-id`, name, value: { value: 'sk-helm', type: 'plain_text' }, models, weight: 1, enabled: true };
}

function helmPlaceholder(models: string[]): FakeProviderKey {
  return {
    id: 'placeholder',
    name: 'placeholder',
    value: { value: '', type: 'plain_text' },
    models,
    weight: 1,
    enabled: true,
  };
}

describe('a managed model provider serves the models the catalog lists', () => {
  let bifrost: FakeBifrost;
  let vendor: FakeVendorApi;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let admin: MemberFixture;
  let tenant: TenantFixture;
  let tenantName: string;

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
    tenant = await createTenant(app);
    tenantName = tenant.name;
    admin = await addMember(app, tenant, [Perms.manageTenantModelProviders]);
  });

  afterEach(() => {
    bifrost.becomeReachable();
    bifrost.setProviders(HELM_PROVIDERS);
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await vendor.close();
  });

  function reconcile(catalog: ModelCatalog): Promise<void> {
    return app.get(ModelProviderKeyModelsService).reconcileKeyModels(catalog);
  }

  function servingOnly(bifrostName: string, models: string[]): void {
    const [key] = keysOf(bifrostName);
    if (!key) throw new Error(`${bifrostName} has no key in the fake Bifrost`);
    key.models = models;
  }

  function keysOf(bifrostName: string): FakeProviderKey[] {
    const provider = bifrost.providerNamed(bifrostName);
    if (!provider) throw new Error(`The fake Bifrost has no provider ${bifrostName}`);
    return provider.keys;
  }

  function keyWrites() {
    return bifrost.writes.filter(
      (write) => write.method === 'PUT' && /^\/api\/providers\/[^/]+\/keys\//.test(write.path)
    );
  }

  async function createCustomProvider(name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-providers',
      headers: admin.headers,
      payload: { baseFormat: 'openai', kind: 'official-api-key', name, key: 'sk-live-own' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const bifrostName = `${tenantName}-${name}`;
    expect(bifrost.providerNamed(bifrostName)?.keys[0]?.models).toEqual(['*']);
    return bifrostName;
  }

  async function createListingCatalog(name: string): Promise<string> {
    const bifrostName = await createCustomProvider(name);
    servingOnly(bifrostName, NEXT_OPENAI_IDS);
    return bifrostName;
  }

  it('turns a key listing the whole catalog into every model, keeping the rest of the key, and a second run writes nothing', async () => {
    const bifrostName = await createListingCatalog('own-key');
    const [created] = keysOf(bifrostName);

    const before = keyWrites().length;
    await reconcile(NEXT_CATALOG);

    expect(keyWrites().slice(before)).toHaveLength(1);
    expect(bifrost.providerNamed(bifrostName)?.keys).toEqual([{ ...created, models: ['*'] }]);

    const afterFirst = keyWrites().length;
    await reconcile(NEXT_CATALOG);
    expect(keyWrites().length).toBe(afterFirst);
  });

  it('leaves a key serving only the models an admin ticked as it is', async () => {
    const bifrostName = await createCustomProvider('ticked');
    servingOnly(bifrostName, ['gpt-7']);

    const before = keyWrites().length;
    await reconcile(NEXT_CATALOG);

    expect(keyWrites().slice(before)).toEqual([]);
    expect(bifrost.providerNamed(bifrostName)?.keys[0]?.models).toEqual(['gpt-7']);
  });

  it('leaves the key-less Dock custom-openai-1, the standard openai key and a provider missing from Bifrost alone', async () => {
    await db
      .insert(modelProviders)
      .values([
        { tenantId: null, bifrostProvider: 'custom-openai-1', chatEnabled: true, chatWeight: 1 },
        { tenantId: null, bifrostProvider: 'opsiforce-gone', chatEnabled: false, chatWeight: 1 },
      ])
      .onConflictDoNothing();
    const standard = staleKey('openai-helm', ['*']);
    const dock = helmPlaceholder([...OPENAI_CATALOG_IDS, 'codex-auto-review']);
    keysOf('openai').push(standard);
    keysOf('custom-openai-1').push(dock);

    const before = keyWrites().length;
    await reconcile(NEXT_CATALOG);

    expect(keyWrites().slice(before)).toEqual([]);
    expect(bifrost.providerNamed('openai')?.keys).toEqual([standard]);
    expect(bifrost.providerNamed('custom-openai-1')?.keys).toEqual([dock]);
  });

  it('turns a signed-in custom-openai-1’s own key into every model and skips the empty Helm placeholder beside it', async () => {
    await db
      .insert(modelProviders)
      .values({ tenantId: null, bifrostProvider: 'custom-openai-1', chatEnabled: true, chatWeight: 1 })
      .onConflictDoNothing();
    const signedIn = bifrost.providerNamed('custom-openai-1');
    if (!signedIn) throw new Error('The fake Bifrost has no custom-openai-1');
    signedIn.keyLess = false;
    signedIn.baseUrl = 'http://opsiforce-linked-account-proxy:8455/v1';
    const own = staleKey('custom-openai-1-key', NEXT_OPENAI_IDS);
    const placeholder = helmPlaceholder([...OPENAI_CATALOG_IDS, 'codex-auto-review']);
    signedIn.keys.push(placeholder, own);

    await reconcile(NEXT_CATALOG);

    expect(bifrost.providerNamed('custom-openai-1')?.keys).toEqual([placeholder, { ...own, models: ['*'] }]);
  });

  it('keeps matching the other providers when Bifrost refuses one, and catches the refused one up at the next run', async () => {
    const refused = await createListingCatalog('refused');
    const matched = await createListingCatalog('matched');

    bifrost.refuseKeyWritesTo(refused);
    await reconcile(NEXT_CATALOG);
    bifrost.refuseKeyWritesTo(null);

    expect(bifrost.providerNamed(refused)?.keys[0]?.models).toEqual(NEXT_OPENAI_IDS);
    expect(bifrost.providerNamed(matched)?.keys[0]?.models).toEqual(['*']);
    await reconcile(NEXT_CATALOG);
    expect(bifrost.providerNamed(refused)?.keys[0]?.models).toEqual(['*']);
  });

  it('does not throw while Bifrost is unreachable, and the next run catches up', async () => {
    const bifrostName = await createListingCatalog('while-down');

    bifrost.becomeUnreachable();
    await expect(reconcile(NEXT_CATALOG)).resolves.toBeUndefined();
    bifrost.becomeReachable();
    expect(bifrost.providerNamed(bifrostName)?.keys[0]?.models).toEqual(NEXT_OPENAI_IDS);

    await reconcile(NEXT_CATALOG);
    expect(bifrost.providerNamed(bifrostName)?.keys[0]?.models).toEqual(['*']);
  });

  describe('a changed catalog reaching every Organization’s keys', () => {
    beforeEach(async () => {
      await db.delete(appliedModelCatalog);
    });

    function applyToKeys(catalog: ModelCatalog): Promise<void> {
      return app.get(ModelProviderKeyModelsService).rewriteKeysForChangedCatalog(catalog);
    }

    async function chatKeyOfNewProject(): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: (await addMember(app, tenant)).headers,
        payload: { title: 'Catalog', agentId: await createAgent() },
      });
      expect(res.statusCode, res.body).toBe(201);
      const keys = await db.select({ id: projectVirtualKeys.bifrostKeyId }).from(projectVirtualKeys);
      bifrost.holdVirtualKeys(keys.map((key) => key.id));
      return bifrost.chatKeyOf(res.json<{ id: string }>().id).id;
    }

    it('rewrites the keys once for a catalog they were not written from, and not again for the same one', async () => {
      const chatKeyId = await chatKeyOfNewProject();
      const writes = () => bifrost.providerConfigWritesTo(chatKeyId).length;

      const before = writes();
      await applyToKeys(NEXT_CATALOG);
      const afterNew = writes();
      await applyToKeys(NEXT_CATALOG);
      const afterSame = writes();
      await applyToKeys(readModelCatalog());

      expect(afterNew).toBeGreaterThan(before);
      expect(afterSame).toBe(afterNew);
      expect(writes()).toBeGreaterThan(afterSame);
      expect(await db.select({ servedModels: appliedModelCatalog.servedModels }).from(appliedModelCatalog)).toEqual([
        { servedModels: { openai: OPENAI_CATALOG_IDS, anthropic: expect.any(Array) } },
      ]);
    });

    it('keeps the catalog unapplied while an Organization’s keys refuse it, so the next boot tries again', async () => {
      const chatKeyId = await chatKeyOfNewProject();

      bifrost.refuseProviderConfigWrites(chatKeyId);
      await applyToKeys(NEXT_CATALOG);
      bifrost.acceptProviderConfigWrites();
      const unapplied = await db.select().from(appliedModelCatalog);
      await applyToKeys(NEXT_CATALOG);

      expect(unapplied).toEqual([]);
      expect(await db.select({ servedModels: appliedModelCatalog.servedModels }).from(appliedModelCatalog)).toEqual([
        { servedModels: { openai: NEXT_OPENAI_IDS, anthropic: ['claude-opus-6'] } },
      ]);
    });
  });
});
