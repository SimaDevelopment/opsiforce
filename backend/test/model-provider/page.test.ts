import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { seedLiveAgent } from '../support/agent-fixtures';
import { DOCK_BASE_URL, startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import {
  addMember,
  createAgent,
  createProject,
  createTenant,
  serviceKeyFor,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const WEIGHT_RULE = 'At least one enabled provider needs a weight above 0';

interface ProviderRow {
  name: string;
  baseFormat: string | null;
  enabled: boolean;
  weight: number;
  status: string;
}

interface ModelProvidersView {
  bifrostReachable: boolean;
  baseFormats: string[];
  providers: ProviderRow[];
}

describe('the Model providers page', () => {
  let bifrost: FakeBifrost;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    harness = await createPublicApiTestApp(bifrost.env, [ModelProvidersModule], [BifrostService]);
    app = harness.app;
    agentId = await createAgent();
  });

  afterEach(() => {
    bifrost.becomeReachable();
    bifrost.acceptProviderConfigWrites();
    bifrost.setProviders(HELM_PROVIDERS);
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
  });

  async function seededTenant(): Promise<{ tenant: TenantFixture; admin: MemberFixture }> {
    const tenant = await createTenant(app);
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

  function list(admin: MemberFixture) {
    return app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });
  }

  function saveFormat(admin: MemberFixture, format: string, providers: Omit<ProviderRow, 'baseFormat' | 'status'>[]) {
    return app.inject({
      method: 'PUT',
      url: `/api/model-providers/formats/${format}`,
      headers: admin.headers,
      payload: { providers },
    });
  }

  async function rowsOf(admin: MemberFixture): Promise<ProviderRow[]> {
    const res = await list(admin);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<ModelProvidersView>().providers;
  }

  describe('listing', () => {
    it('shows each Built-in row with only its name, Base format, switch, weight and status', async () => {
      const { admin } = await seededTenant();

      const res = await list(admin);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<ModelProvidersView>()).toEqual({
        bifrostReachable: true,
        baseFormats: ['openai', 'anthropic'],
        providers: [
          { name: 'anthropic', baseFormat: 'anthropic', enabled: true, weight: 1, status: 'working' },
          { name: 'custom-openai-1', baseFormat: 'openai', enabled: true, weight: 1, status: 'working' },
          { name: 'openai', baseFormat: 'openai', enabled: true, weight: 0, status: 'working' },
        ],
      });
      expect(res.body).not.toContain(DOCK_BASE_URL);
    });

    it('reads Failing from the provider status and missing when Bifrost has no such provider', async () => {
      const { admin } = await seededTenant();
      bifrost.setProviders(['openai', 'anthropic']);
      bifrost.setProviderStatus('anthropic', 'error');

      expect(await rowsOf(admin)).toEqual([
        { name: 'anthropic', baseFormat: 'anthropic', enabled: true, weight: 1, status: 'failing' },
        { name: 'custom-openai-1', baseFormat: null, enabled: true, weight: 1, status: 'missing' },
        { name: 'openai', baseFormat: 'openai', enabled: true, weight: 0, status: 'working' },
      ]);
    });

    it('reads every status as Unknown when Bifrost is unreachable', async () => {
      const { admin } = await seededTenant();
      bifrost.becomeUnreachable();

      const res = await list(admin);

      expect(res.statusCode, res.body).toBe(200);
      const view = res.json<ModelProvidersView>();
      expect(view.bifrostReachable).toBe(false);
      expect(view.providers.map((row) => row.status)).toEqual(['unknown', 'unknown', 'unknown']);
    });
  });

  describe('saving a Base format card', () => {
    it('projects the weights into every chat key of the Organization and no other Organization’s keys', async () => {
      const { tenant, admin } = await seededTenant();
      const first = await projectOf(tenant);
      const second = await projectOf(tenant);
      const neighbour = await projectOf((await seededTenant()).tenant);
      const neighbourConfigs = bifrost.chatKeyOf(neighbour).provider_configs;
      const backendWrites = bifrost.providerConfigWritesTo(bifrost.backendKeyOf(first).id).length;

      const res = await saveFormat(admin, 'openai', [
        { name: 'openai', enabled: true, weight: 3 },
        { name: 'custom-openai-1', enabled: true, weight: 1 },
      ]);

      expect(res.statusCode, res.body).toBe(200);
      const expected = [
        { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
        { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
        { provider: 'openai', weight: 3, ...CATALOG_WIDE },
      ];
      expect(bifrost.chatKeyOf(first).provider_configs).toEqual(expected);
      expect(bifrost.chatKeyOf(second).provider_configs).toEqual(expected);
      expect(bifrost.chatKeyOf(neighbour).provider_configs).toEqual(neighbourConfigs);
      expect(bifrost.providerConfigWritesTo(bifrost.backendKeyOf(first).id)).toHaveLength(backendWrites);
      expect(res.json<ModelProvidersView>().providers).toContainEqual({
        name: 'openai',
        baseFormat: 'openai',
        enabled: true,
        weight: 3,
        status: 'working',
      });
    });

    it('leaves a switched-off row out of the chat keys and keeps a weight-0 row as a backup', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);

      const saved = await saveFormat(admin, 'openai', [
        { name: 'openai', enabled: true, weight: 0 },
        { name: 'custom-openai-1', enabled: true, weight: 2 },
      ]);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
        { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
        { provider: 'custom-openai-1', weight: 2, ...CATALOG_WIDE },
        { provider: 'openai', weight: 0, ...CATALOG_WIDE },
      ]);

      const switchedOff = await saveFormat(admin, 'openai', [
        { name: 'openai', enabled: true, weight: 1 },
        { name: 'custom-openai-1', enabled: false, weight: 2 },
      ]);
      expect(switchedOff.statusCode, switchedOff.body).toBe(200);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
        { provider: 'anthropic', weight: 1, ...CATALOG_WIDE },
        { provider: 'openai', weight: 1, ...CATALOG_WIDE },
      ]);
    });

    it('refuses a format whose enabled rows are all at weight 0 and changes nothing', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);
      const before = bifrost.chatKeyOf(projectId).provider_configs;

      const res = await saveFormat(admin, 'openai', [
        { name: 'openai', enabled: true, weight: 0 },
        { name: 'custom-openai-1', enabled: true, weight: 0 },
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toBe(WEIGHT_RULE);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual(before);
      expect((await rowsOf(admin)).find((row) => row.name === 'custom-openai-1')?.weight).toBe(1);
    });

    it('allows switching every row of a format off', async () => {
      const { tenant, admin } = await seededTenant();
      const projectId = await projectOf(tenant);

      const res = await saveFormat(admin, 'anthropic', [{ name: 'anthropic', enabled: false, weight: 1 }]);

      expect(res.statusCode, res.body).toBe(200);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toEqual([
        { provider: 'custom-openai-1', weight: 1, ...CATALOG_WIDE },
        { provider: 'openai', weight: 0, ...CATALOG_WIDE },
      ]);
    });

    it('refuses a row of another format, an unknown row and a weight outside 0–100', async () => {
      const { admin } = await seededTenant();

      const otherFormat = await saveFormat(admin, 'openai', [{ name: 'anthropic', enabled: true, weight: 1 }]);
      const unknown = await saveFormat(admin, 'openai', [{ name: 'someone-else', enabled: true, weight: 1 }]);
      const tooHeavy = await saveFormat(admin, 'openai', [{ name: 'openai', enabled: true, weight: 101 }]);
      const fractional = await saveFormat(admin, 'openai', [{ name: 'openai', enabled: true, weight: 1.5 }]);
      const unknownFormat = await saveFormat(admin, 'gemini', [{ name: 'openai', enabled: true, weight: 1 }]);

      expect([otherFormat, unknown, tooHeavy, fractional, unknownFormat].map((res) => res.statusCode)).toEqual([
        400, 400, 400, 400, 400,
      ]);
      expect((await rowsOf(admin)).find((row) => row.name === 'openai')).toMatchObject({ enabled: true, weight: 0 });
    });

    it('refuses every save while Bifrost is unreachable', async () => {
      const { admin } = await seededTenant();
      bifrost.becomeUnreachable();

      const res = await saveFormat(admin, 'anthropic', [{ name: 'anthropic', enabled: true, weight: 5 }]);

      expect(res.statusCode).toBe(503);
      bifrost.becomeReachable();
      expect((await rowsOf(admin)).find((row) => row.name === 'anthropic')?.weight).toBe(1);
    });

    it('fails the save and keeps the rows when a chat key refuses the new split', async () => {
      const { tenant, admin } = await seededTenant();
      await projectOf(tenant);
      bifrost.refuseProviderConfigWrites();

      const res = await saveFormat(admin, 'anthropic', [{ name: 'anthropic', enabled: true, weight: 5 }]);

      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      bifrost.acceptProviderConfigWrites();
      expect((await rowsOf(admin)).find((row) => row.name === 'anthropic')?.weight).toBe(1);
    });
  });

  describe('who may use it', () => {
    it('refuses a member without can_manage_tenant_model_providers on every route', async () => {
      const { tenant } = await seededTenant();
      const member = await addMember(app, tenant, [Perms.manageTenantBudget, Perms.manageTenantDefaults]);

      const listed = await list(member);
      const saved = await saveFormat(member, 'anthropic', [{ name: 'anthropic', enabled: false, weight: 1 }]);

      expect([listed.statusCode, saved.statusCode]).toEqual([403, 403]);
    });

    it('refuses an Agent Caller, even alongside a permitted human’s headers', async () => {
      const { tenant, admin } = await seededTenant();
      const agent = await seedLiveAgent(tenant.tenantId, admin.userId);
      const callerProjectId = await createProject(app, tenant, { agentId: agent.id, createdBy: admin.userId });
      const callerKey = await serviceKeyFor(app, tenant, callerProjectId);
      const bearer = { authorization: `Bearer ${callerKey}` };

      const alone = await app.inject({ method: 'GET', url: '/api/model-providers', headers: bearer });
      const withHuman = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/anthropic',
        headers: { ...admin.headers, ...bearer },
        payload: { providers: [{ name: 'anthropic', enabled: false, weight: 1 }] },
      });

      expect([alone.statusCode, withHuman.statusCode]).toEqual([403, 403]);
      expect((await rowsOf(admin)).find((row) => row.name === 'anthropic')?.enabled).toBe(true);
    });

    it('has no public API route', async () => {
      const { admin } = await seededTenant();

      const res = await app.inject({ method: 'GET', url: '/api/v1/model-providers', headers: admin.headers });

      expect(res.statusCode).toBe(404);
    });
  });
});
