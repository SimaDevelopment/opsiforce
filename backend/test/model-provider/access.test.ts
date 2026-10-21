import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { agentProfiles, modelProviderAvailability, projectVirtualKeys } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { seedLiveAgent } from '../support/agent-fixtures';
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

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];

interface SeededTenant {
  tenant: TenantFixture;
  admin: MemberFixture;
  projectId: string;
}

interface AccessView {
  providers: { name: string; baseFormats: string[]; mode: 'every' | 'chosen' }[];
  tenants: { tenantId: string; displayName: string; withheld: string[] }[];
}

describe('withholding a Built-in model provider from an Organization', () => {
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

  afterEach(async () => {
    bifrost.becomeReachable();
    bifrost.setProviders(HELM_PROVIDERS);
    await db.delete(modelProviderAvailability);
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

  function setAccess(seeded: SeededTenant, name: string, payload: Record<string, unknown>, member = platformAdmin) {
    return app.inject({
      method: 'PUT',
      url: `/api/platform-model-providers/${name}/access/${seeded.tenant.tenantId}`,
      headers: member.headers,
      payload,
    });
  }

  async function withhold(seeded: SeededTenant, name: string): Promise<void> {
    const res = await setAccess(seeded, name, { withheld: true });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function namesSeenBy(seeded: SeededTenant): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: seeded.admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: { name: string }[] }>().providers.map((row) => row.name);
  }

  async function holdEveryProjectKey(): Promise<void> {
    const keys = await db.select({ id: projectVirtualKeys.bifrostKeyId }).from(projectVirtualKeys);
    bifrost.holdVirtualKeys(keys.map((key) => key.id));
  }

  function chatProvidersOf(seeded: SeededTenant): string[] {
    return bifrost.chatKeyOf(seeded.projectId).provider_configs.map((config) => config.provider);
  }

  async function accessView(): Promise<AccessView> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/platform-model-providers/access',
      headers: platformAdmin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<AccessView>();
  }

  async function accessOf(seeded: SeededTenant): Promise<string[] | undefined> {
    return (await accessView()).tenants.find((row) => row.tenantId === seeded.tenant.tenantId)?.withheld;
  }

  function setMode(name: string, mode: string, member = platformAdmin) {
    return app.inject({
      method: 'PUT',
      url: `/api/platform-model-providers/${name}/availability`,
      headers: member.headers,
      payload: { mode },
    });
  }

  async function createGlobal(name: string, availability: Record<string, unknown>) {
    await holdEveryProjectKey();
    const res = await app.inject({
      method: 'POST',
      url: '/api/platform-model-providers',
      headers: platformAdmin.headers,
      payload: { baseFormat: 'openai', kind: 'official-api-key', name, key: `sk-${name}`, availability },
    });
    expect(res.statusCode, res.body).toBe(201);
  }

  async function deleteGlobal(name: string): Promise<void> {
    await holdEveryProjectKey();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/platform-model-providers/${name}`,
      headers: platformAdmin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  it('lists every Built-in model provider and what each Organization has withheld', async () => {
    const seeded = await seededTenant();
    await withhold(seeded, 'openai');

    const res = await app.inject({
      method: 'GET',
      url: '/api/platform-model-providers/access',
      headers: platformAdmin.headers,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<AccessView>().providers.map((provider) => provider.name)).toEqual(
      expect.arrayContaining(['anthropic', 'custom-openai-1', 'openai'])
    );
    expect(await accessOf(seeded)).toEqual(['openai']);
  });

  it('takes the provider out of that Organization’s chat keys and its admin’s page, and no other Organization’s', async () => {
    const withheldFrom = await seededTenant();
    const other = await seededTenant();

    await withhold(withheldFrom, 'openai');

    expect(chatProvidersOf(withheldFrom)).not.toContain('openai');
    expect(await namesSeenBy(withheldFrom)).not.toContain('openai');
    expect(chatProvidersOf(other)).toContain('openai');
    expect(await namesSeenBy(other)).toContain('openai');
  });

  it('refuses the Organization admin’s save that names a withheld provider', async () => {
    const seeded = await seededTenant();
    await withhold(seeded, 'openai');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/model-providers/formats/openai',
      headers: seeded.admin.headers,
      payload: { providers: [{ name: 'openai', chatEnabled: true, chatWeight: 1 }] },
    });

    expect(res.statusCode).toBe(400);
    expect(chatProvidersOf(seeded)).not.toContain('openai');
  });

  it('gives the Organization back its own earlier switch and weight when made available again', async () => {
    const seeded = await seededTenant();
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/model-providers/formats/openai',
      headers: seeded.admin.headers,
      payload: { providers: [{ name: 'openai', chatEnabled: true, chatWeight: 7 }] },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await withhold(seeded, 'openai');

    const res = await setAccess(seeded, 'openai', { withheld: false });

    expect(res.statusCode, res.body).toBe(200);
    expect(await accessOf(seeded)).toEqual([]);
    expect(bifrost.chatKeyOf(seeded.projectId).provider_configs).toContainEqual(
      expect.objectContaining({ provider: 'openai', weight: 7 })
    );
  });

  it('withholds even the last provider of a format an Agent uses, leaving the Agent as it is', async () => {
    const seeded = await seededTenant();
    const agent = await seedLiveAgent(seeded.tenant.tenantId, seeded.admin.userId, { visibility: 'private' });
    await db
      .update(agentProfiles)
      .set({ model: 'anthropic/claude-sonnet-5' })
      .where(eq(agentProfiles.agentId, agent.id));

    const withheld = await setAccess(seeded, 'anthropic', { withheld: true });

    expect(withheld.statusCode, withheld.body).toBe(200);
    expect(chatProvidersOf(seeded)).not.toContain('anthropic');
  });

  it('puts the Organization’s keys back when one of them refuses an access change', async () => {
    const seeded = await seededTenant();
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: (await addMember(app, seeded.tenant)).headers,
      payload: { title: 'Second', agentId },
    });
    expect(second.statusCode, second.body).toBe(201);
    bifrost.refuseProviderConfigWrites(bifrost.chatKeyOf(second.json<{ id: string }>().id).id);

    const refused = await setAccess(seeded, 'openai', { withheld: true });
    bifrost.acceptProviderConfigWrites();

    expect(refused.statusCode).toBeGreaterThanOrEqual(500);
    expect(await accessOf(seeded)).toEqual([]);
    expect(chatProvidersOf(seeded)).toContain('openai');
  });

  it('withholds the platform Linked account before its first sign-in', async () => {
    const seeded = await seededTenant();

    await withhold(seeded, 'custom-openai-1');

    expect(await accessOf(seeded)).toEqual(['custom-openai-1']);
    expect(await namesSeenBy(seeded)).not.toContain('custom-openai-1');
  });

  it('forgets what was withheld when a global provider is deleted', async () => {
    const seeded = await seededTenant();
    await holdEveryProjectKey();
    const created = await app.inject({
      method: 'POST',
      url: '/api/platform-model-providers',
      headers: platformAdmin.headers,
      payload: { baseFormat: 'openai', kind: 'official-api-key', name: 'withheld', key: 'sk-withheld' },
    });
    expect(created.statusCode, created.body).toBe(201);
    await withhold(seeded, 'opsiforce-withheld');

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/platform-model-providers/opsiforce-withheld',
      headers: platformAdmin.headers,
    });

    expect(removed.statusCode, removed.body).toBe(200);
    expect(await accessOf(seeded)).toEqual([]);
  });

  it('refuses an unknown provider, an unknown Organization, a missing choice and an Organization admin', async () => {
    const seeded = await seededTenant();

    expect((await setAccess(seeded, 'nope', { withheld: true })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/platform-model-providers/openai/access/no-such-tenant',
          headers: platformAdmin.headers,
          payload: { withheld: true },
        })
      ).statusCode
    ).toBe(404);
    expect((await setAccess(seeded, 'openai', {})).statusCode).toBe(400);
    expect((await setAccess(seeded, 'openai', { withheld: true }, seeded.admin)).statusCode).toBe(403);
    expect(await accessOf(seeded)).toEqual([]);
  });

  describe('for every Organization, or only the chosen ones', () => {
    it('gives a provider created for chosen Organizations to those only, and not to one created afterwards', async () => {
      const chosen = await seededTenant();
      const other = await seededTenant();

      await createGlobal('for-chosen', { mode: 'chosen', tenantIds: [chosen.tenant.tenantId] });
      const later = await seededTenant();

      expect(await namesSeenBy(chosen)).toContain('opsiforce-for-chosen');
      expect(await namesSeenBy(other)).not.toContain('opsiforce-for-chosen');
      expect(await namesSeenBy(later)).not.toContain('opsiforce-for-chosen');
      expect((await accessView()).providers).toContainEqual(
        expect.objectContaining({ name: 'opsiforce-for-chosen', mode: 'chosen' })
      );
      await deleteGlobal('opsiforce-for-chosen');
    });

    it('gives a provider created for every Organization to one created afterwards', async () => {
      await createGlobal('for-every', { mode: 'every' });
      const later = await seededTenant();

      expect(await namesSeenBy(later)).toContain('opsiforce-for-every');
      await deleteGlobal('opsiforce-for-every');
    });

    it('refuses an unknown chosen Organization and an unknown mode', async () => {
      await holdEveryProjectKey();
      for (const availability of [{ mode: 'chosen', tenantIds: ['no-such'] }, { mode: 'some' }]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/platform-model-providers',
          headers: platformAdmin.headers,
          payload: { baseFormat: 'openai', kind: 'official-api-key', name: 'refused', key: 'sk-x', availability },
        });
        expect(res.statusCode, res.body).toBe(400);
      }
    });

    it('keeps every Organization’s access when switched to chosen, and leaves out Organizations created afterwards', async () => {
      const kept = await seededTenant();
      const withheld = await seededTenant();
      await withhold(withheld, 'openai');

      const switched = await setMode('openai', 'chosen');
      const later = await seededTenant();

      expect(switched.statusCode, switched.body).toBe(200);
      expect(await namesSeenBy(kept)).toContain('openai');
      expect(chatProvidersOf(kept)).toContain('openai');
      expect(await namesSeenBy(withheld)).not.toContain('openai');
      expect(await namesSeenBy(later)).not.toContain('openai');
      expect(chatProvidersOf(later)).not.toContain('openai');
    });

    it('keeps every Organization’s access when switched back to every, and gives it to Organizations created afterwards', async () => {
      const withheld = await seededTenant();
      expect((await setMode('openai', 'chosen')).statusCode).toBe(200);
      const leftOut = await seededTenant();

      const switched = await setMode('openai', 'every');
      const later = await seededTenant();

      expect(switched.statusCode, switched.body).toBe(200);
      expect(await namesSeenBy(withheld)).toContain('openai');
      expect(await namesSeenBy(leftOut)).not.toContain('openai');
      expect(await namesSeenBy(later)).toContain('openai');
    });

    it('refuses an unknown mode, an unknown provider and an Organization admin', async () => {
      const seeded = await seededTenant();

      expect((await setMode('openai', 'some')).statusCode).toBe(400);
      expect((await setMode('nope', 'chosen')).statusCode).toBe(404);
      expect((await setMode('openai', 'chosen', seeded.admin)).statusCode).toBe(403);
    });
  });
});
