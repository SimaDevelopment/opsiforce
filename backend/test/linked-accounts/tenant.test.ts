import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { projectVirtualKeys } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { LinkedAccountsModule } from '../../src/linked-accounts/linked-accounts.module';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { FAKE_USER_CODE, startFakeChatGptAuth, type FakeChatGptAuth } from './support/fake-chatgpt-auth';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';
import { BASE_FORMATS } from '../../src/model-provider/base-formats';
import { servedModelsOf } from '../../src/model-provider/bifrost-provider-shape';

const PROXY_URL = 'http://opsiforce-linked-account-proxy:8455/v1';
const SERVICE_TOKEN = 'linked-account-proxy-service-token';
const ENCRYPTION_KEY = 'b'.repeat(64);
const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const OPENAI_FAMILY = { allowed_models: servedModelsOf(BASE_FORMATS.openai), key_ids: ['*'] };
const POLL_GAP_MS = 5_000;
const SIGN_IN_LIFETIME_MS = 15 * 60 * 1000;
const TENANT_ACCOUNT = { email: 'team@acme.test', accountId: 'chatgpt-account-acme' };

interface ProviderRow {
  name: string;
  kind?: string | null;
  baseFormat: string | null;
  chatEnabled: boolean;
  chatWeight: number;
  status: string;
}

interface LinkedAccountView {
  vendor: string;
  state: string;
  signedInAs: string | null;
  reason: string | null;
  signIn: { state: string; userCode?: string; verificationUrl?: string; expiresAt?: string } | null;
}

interface SeededTenant {
  tenant: TenantFixture;
  admin: MemberFixture;
}

function linkedAccount(name = 'team-chatgpt') {
  return { baseFormat: 'openai', kind: 'linked-account', vendor: 'chatgpt', name };
}

function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('an Organization signs in its own Linked account', () => {
  let bifrost: FakeBifrost;
  let chatgpt: FakeChatGptAuth;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let agentId: string;

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    chatgpt = await startFakeChatGptAuth();
    harness = await createPublicApiTestApp(
      {
        ...bifrost.env,
        EXTERNAL_SERVICES_ENCRYPTION_KEY: ENCRYPTION_KEY,
        LINKED_ACCOUNT_PROXY_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      [ModelProvidersModule, LinkedAccountsModule],
      [BifrostService]
    );
    app = harness.app;
    agentId = await createAgent();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    chatgpt.signInAs(TENANT_ACCOUNT);
    await holdEveryProjectKey();
  });

  afterEach(() => {
    vi.useRealTimers();
    bifrost.becomeReachable();
    chatgpt.reset();
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await chatgpt.close();
  });

  async function seededTenant(): Promise<SeededTenant> {
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

  async function holdEveryProjectKey(): Promise<void> {
    const keys = await db.select({ id: projectVirtualKeys.bifrostKeyId }).from(projectVirtualKeys);
    bifrost.holdVirtualKeys(keys.map((key) => key.id));
  }

  function create(admin: MemberFixture, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/model-providers', headers: admin.headers, payload });
  }

  async function added(seeded: SeededTenant, name = 'team-chatgpt'): Promise<string> {
    const res = await create(seeded.admin, linkedAccount(name));
    expect(res.statusCode, res.body).toBe(201);
    return `${seeded.tenant.name}-${name}`;
  }

  function startSignIn(admin: MemberFixture, name = 'team-chatgpt') {
    return app.inject({
      method: 'POST',
      url: `/api/model-providers/${encodeURIComponent(name)}/sign-in`,
      headers: admin.headers,
    });
  }

  function readStatus(admin: MemberFixture, name = 'team-chatgpt') {
    return app.inject({
      method: 'GET',
      url: `/api/model-providers/${encodeURIComponent(name)}/linked-account`,
      headers: admin.headers,
    });
  }

  function readUsage(admin: MemberFixture, name = 'team-chatgpt') {
    return app.inject({
      method: 'GET',
      url: `/api/model-providers/${encodeURIComponent(name)}/linked-account/usage`,
      headers: admin.headers,
    });
  }

  async function statusOf(admin: MemberFixture, name = 'team-chatgpt'): Promise<LinkedAccountView> {
    const res = await readStatus(admin, name);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<LinkedAccountView>();
  }

  async function signIn(seeded: SeededTenant, name = 'team-chatgpt'): Promise<void> {
    const started = await startSignIn(seeded.admin, name);
    expect(started.statusCode, started.body).toBe(200);
    chatgpt.replyToDevicePolls('approved');
    expect((await statusOf(seeded.admin, name)).state).toBe('connected');
    chatgpt.replyToDevicePolls('pending');
  }

  async function rowsOf(admin: MemberFixture): Promise<ProviderRow[]> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: ProviderRow[] }>().providers;
  }

  function chatProvidersOf(projectId: string): string[] {
    return bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider);
  }

  function callerSecretOf(bifrostName: string): string {
    const [key] = bifrost.providerNamed(bifrostName)?.keys ?? [];
    if (!key) throw new Error(`${bifrostName} has no key in the fake Bifrost`);
    return (key.value as { value: string }).value;
  }

  function fetchCredential(callerSecret: string) {
    return app.inject({
      method: 'POST',
      url: '/api/internal/linked-accounts/credential',
      headers: { 'x-linked-account-proxy-token': SERVICE_TOKEN },
      payload: { caller_secret: callerSecret },
    });
  }

  describe('adding one', () => {
    it('is created awaiting sign-in, pointed at the proxy with its own lap_ key, and kept out of the chat keys', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);

      const res = await create(seeded.admin, linkedAccount());

      expect(res.statusCode, res.body).toBe(201);
      const bifrostName = `${seeded.tenant.name}-team-chatgpt`;
      expect(res.json<{ providers: ProviderRow[] }>().providers).toContainEqual({
        name: 'team-chatgpt',
        kind: 'linked-account',
        baseFormat: 'openai',
        chatEnabled: true,
        chatWeight: 1,
        backendEnabled: false,
        backendWeight: 1,
        status: 'not-signed-in',
      });
      const provider = bifrost.providerNamed(bifrostName);
      expect(provider?.created).toMatchObject({
        provider: bifrostName,
        network_config: { base_url: PROXY_URL, allow_private_network: true },
        custom_provider_config: { base_provider_type: 'openai', is_key_less: false },
      });
      expect(provider?.keys).toEqual([
        {
          id: expect.any(String),
          name: `${bifrostName}-key`,
          value: { value: expect.stringMatching(/^lap_[A-Za-z0-9_-]{40,}$/), type: 'plain_text' },
          models: ['*'],
          weight: 1,
          enabled: true,
        },
      ]);
      expect(await statusOf(seeded.admin)).toEqual({
        vendor: 'chatgpt',
        state: 'awaiting-sign-in',
        signedInAs: null,
        reason: null,
        signIn: null,
      });
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);
      expect(chatgpt.usercodeRequests).toBe(0);
    });

    it('is offered on the OpenAI card only and refused on any other format or for an unknown vendor', async () => {
      const seeded = await seededTenant();

      const rules = await app.inject({
        method: 'GET',
        url: '/api/model-providers/creation-rules',
        headers: seeded.admin.headers,
      });
      const refused = await Promise.all([
        create(seeded.admin, { ...linkedAccount(), baseFormat: 'anthropic' }),
        create(seeded.admin, { ...linkedAccount(), vendor: 'claude' }),
        create(seeded.admin, { ...linkedAccount(), vendor: undefined }),
      ]);

      expect(rules.json<{ kindsByFormat: Record<string, string[]> }>().kindsByFormat).toEqual({
        openai: ['official-api-key', 'compatible-endpoint', 'linked-account', 'azure-foundry'],
        anthropic: ['official-api-key', 'compatible-endpoint', 'azure-foundry'],
      });
      expect(refused.map((res) => res.statusCode)).toEqual([400, 400, 400]);
      expect(bifrost.providerNamed(`${seeded.tenant.name}-team-chatgpt`)).toBeUndefined();
      expect((await rowsOf(seeded.admin)).map((row) => row.name)).not.toContain('team-chatgpt');
    });

    it('has no connection test: it is proven by signing in', async () => {
      const seeded = await seededTenant();

      const res = await app.inject({
        method: 'POST',
        url: '/api/model-providers/test',
        headers: seeded.admin.headers,
        payload: linkedAccount(),
      });

      expect(res.statusCode).toBe(400);
      expect(bifrost.providerNamed(`${seeded.tenant.name}-team-chatgpt`)).toBeUndefined();
    });

    it('can only be re-keyed by signing in again, not with a typed key', async () => {
      const seeded = await seededTenant();
      await added(seeded);

      const edited = await app.inject({
        method: 'PATCH',
        url: '/api/model-providers/team-chatgpt',
        headers: seeded.admin.headers,
        payload: { key: 'sk-typed' },
      });

      expect(edited.statusCode).toBe(400);
      expect(callerSecretOf(`${seeded.tenant.name}-team-chatgpt`)).toMatch(/^lap_/);
    });
  });

  describe('signing in', () => {
    it('shows the code, then turns Connected · email by itself and joins the chat keys', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);

      const started = await startSignIn(seeded.admin);

      expect(started.statusCode, started.body).toBe(200);
      expect(started.json()).toEqual({
        userCode: FAKE_USER_CODE,
        verificationUrl: `${chatgpt.issuer}/codex/device`,
        expiresAt: expect.any(String),
      });
      expect(await statusOf(seeded.admin)).toMatchObject({
        state: 'awaiting-sign-in',
        signIn: { state: 'pending', userCode: FAKE_USER_CODE },
      });
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);

      chatgpt.replyToDevicePolls('approved');
      advanceClock(POLL_GAP_MS);

      expect(await statusOf(seeded.admin)).toEqual({
        vendor: 'chatgpt',
        state: 'connected',
        signedInAs: 'team@acme.test',
        reason: null,
        signIn: null,
      });
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: bifrostName,
        weight: 1,
        ...OPENAI_FAMILY,
      });
      const credential = await fetchCredential(callerSecretOf(bifrostName));
      expect(credential.statusCode, credential.body).toBe(200);
      expect(credential.json()).toMatchObject({ vendor: 'chatgpt', accountId: 'chatgpt-account-acme' });
    });

    it('completes when the page comes back within 15 minutes, and a colleague can finish what another started', async () => {
      const seeded = await seededTenant();
      const colleague = await addMember(app, seeded.tenant, [Perms.manageTenantModelProviders]);
      await added(seeded);
      await startSignIn(seeded.admin);
      chatgpt.replyToDevicePolls('approved');

      advanceClock(SIGN_IN_LIFETIME_MS - 60_000);

      expect(await statusOf(colleague)).toMatchObject({ state: 'connected', signedInAs: 'team@acme.test' });
      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected' });
    });

    it('shows Sign-in expired after 15 minutes, stays out of the chat keys, and can start again', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await startSignIn(seeded.admin);
      await statusOf(seeded.admin);
      const pollsBefore = chatgpt.devicePolls;
      chatgpt.replyToDevicePolls('approved');

      advanceClock(SIGN_IN_LIFETIME_MS);

      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'awaiting-sign-in', signIn: { state: 'expired' } });
      expect(chatgpt.devicePolls).toBe(pollsBefore);
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);

      expect((await startSignIn(seeded.admin)).statusCode).toBe(200);
      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected' });
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
    });

    it('requires can_manage_tenant_model_providers on every Linked-account route', async () => {
      const seeded = await seededTenant();
      await added(seeded);
      const member = await addMember(app, seeded.tenant);
      const platformAdmin = await addMember(app, seeded.tenant, [Perms.managePlatformModelProviders]);

      const responses = await Promise.all(
        [member, platformAdmin].flatMap((caller) => [
          create(caller, linkedAccount('another')),
          startSignIn(caller),
          readStatus(caller),
          readUsage(caller),
        ])
      );

      expect(responses.map((res) => res.statusCode)).toEqual([403, 403, 403, 403, 403, 403, 403, 403]);
      expect(chatgpt.usercodeRequests).toBe(0);
    });

    it('is not offered on a Built-in row or on a keyed Custom row', async () => {
      const seeded = await seededTenant();

      const responses = await Promise.all([
        startSignIn(seeded.admin, 'custom-openai-1'),
        readStatus(seeded.admin, 'openai'),
      ]);

      expect(responses.map((res) => res.statusCode)).toEqual([404, 404]);
      expect(chatgpt.usercodeRequests).toBe(0);
    });
  });

  describe('its subscription usage', () => {
    it('shows the plan and each limit window, read from OpenAI with the account’s own token', async () => {
      const seeded = await seededTenant();
      await added(seeded);
      await signIn(seeded);
      chatgpt.reportUsage({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 38,
            limit_window_seconds: 18_000,
            reset_after_seconds: 600,
            reset_at: 1_790_000_000,
          },
          secondary_window: {
            used_percent: 104,
            limit_window_seconds: 604_800,
            reset_after_seconds: 9_000,
            reset_at: 1_790_400_000,
          },
        },
      });

      const res = await readUsage(seeded.admin);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        plan: 'plus',
        windows: [
          { windowMinutes: 300, usedPercent: 38, resetsAt: new Date(1_790_000_000_000).toISOString() },
          { windowMinutes: 10_080, usedPercent: 100, resetsAt: new Date(1_790_400_000_000).toISOString() },
        ],
      });
      expect(chatgpt.usageRequests).toEqual([
        { accessToken: chatgpt.issuedAccessTokens.at(-1), accountId: TENANT_ACCOUNT.accountId },
      ]);
    });

    it('is refused before sign-in, and answers 502 without OpenAI’s reply when OpenAI fails', async () => {
      const seeded = await seededTenant();
      await added(seeded);

      const beforeSignIn = await readUsage(seeded.admin);
      await signIn(seeded);
      chatgpt.reportUsage(500);
      const failing = await readUsage(seeded.admin);

      expect(beforeSignIn.statusCode, beforeSignIn.body).toBe(409);
      expect(failing.statusCode, failing.body).toBe(502);
      expect(failing.body).not.toContain('usage failed');
      expect(chatgpt.usageRequests).toHaveLength(1);
    });
  });

  describe('isolation between Organizations', () => {
    it('keeps a signed-in account unreachable from another Organization, even by guessing its name', async () => {
      const owner = await seededTenant();
      const other = await seededTenant();
      const ownerProject = await projectOf(owner.tenant);
      const otherProject = await projectOf(other.tenant);
      const bifrostName = await added(owner);
      await signIn(owner);

      const guesses = await Promise.all([
        readStatus(other.admin),
        readStatus(other.admin, bifrostName),
        startSignIn(other.admin, bifrostName),
        app.inject({
          method: 'PUT',
          url: '/api/model-providers/formats/openai',
          headers: other.admin.headers,
          payload: { providers: [{ name: bifrostName, chatEnabled: true, chatWeight: 5 }] },
        }),
        app.inject({
          method: 'DELETE',
          url: `/api/model-providers/${encodeURIComponent(bifrostName)}`,
          headers: other.admin.headers,
        }),
      ]);

      expect(guesses.map((res) => res.statusCode)).toEqual([404, 404, 404, 400, 404]);
      expect(chatProvidersOf(ownerProject)).toContain(bifrostName);
      expect(chatProvidersOf(otherProject)).not.toContain(bifrostName);
      expect(bifrost.chatKeyOf(otherProject).provider_configs.map((config) => config.provider)).toEqual(
        expect.not.arrayContaining([expect.stringContaining(owner.tenant.name)])
      );
      expect(chatgpt.usercodeRequests).toBe(1);
    });

    it('resolves each lap_ secret to its own Organization’s account only', async () => {
      const first = await seededTenant();
      const second = await seededTenant();
      const firstName = await added(first);
      const secondName = await added(second);
      await signIn(first);
      chatgpt.signInAs({ email: 'other@globex.test', accountId: 'chatgpt-account-globex' });
      await signIn(second);

      const [firstCredential, secondCredential] = await Promise.all([
        fetchCredential(callerSecretOf(firstName)),
        fetchCredential(callerSecretOf(secondName)),
      ]);

      expect(firstCredential.json()).toMatchObject({ accountId: 'chatgpt-account-acme' });
      expect(secondCredential.json()).toMatchObject({ accountId: 'chatgpt-account-globex' });
      expect(callerSecretOf(firstName)).not.toBe(callerSecretOf(secondName));
      expect((await statusOf(first.admin)).signedInAs).toBe('team@acme.test');
      expect((await statusOf(second.admin)).signedInAs).toBe('other@globex.test');
    });
  });

  describe('its status on the card', () => {
    it('reads Not signed in while it carries no traffic, and Working once it is connected', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);

      const before = (await rowsOf(seeded.admin)).find((row) => row.name === 'team-chatgpt');

      expect(before).toMatchObject({ chatEnabled: true, chatWeight: 1, status: 'not-signed-in' });
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);

      await signIn(seeded);

      expect((await rowsOf(seeded.admin)).find((row) => row.name === 'team-chatgpt')).toMatchObject({
        status: 'working',
      });
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
    });

    it('leaves the format’s rows that are in traffic as they are, even when the only one left is a backup', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      await added(seeded);
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: seeded.admin.headers,
        payload: {
          providers: [
            { name: 'openai', chatEnabled: true, chatWeight: 0 },
            { name: 'custom-openai-1', chatEnabled: false, chatWeight: 1 },
          ],
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const openaiRows = (await rowsOf(seeded.admin)).filter((row) => row.baseFormat === 'openai');

      expect(openaiRows.map((row) => [row.name, row.chatEnabled, row.chatWeight, row.status])).toEqual([
        ['custom-openai-1', false, 1, 'working'],
        ['openai', true, 0, 'working'],
        ['team-chatgpt', true, 1, 'not-signed-in'],
      ]);
      expect(bifrost.chatKeyOf(projectId).provider_configs.filter((config) => config.provider !== 'anthropic')).toEqual(
        [{ provider: 'openai', weight: 0, ...CATALOG_WIDE }]
      );
    });

    it('warns before a save that leaves the format only a Linked account that is not signed in', async () => {
      const seeded = await seededTenant();
      await added(seeded);

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: seeded.admin.headers,
        payload: {
          providers: [
            { name: 'openai', chatEnabled: false, chatWeight: 0 },
            { name: 'custom-openai-1', chatEnabled: false, chatWeight: 1 },
          ],
        },
      });

      expect(saved.statusCode, saved.body).toBe(409);
      expect(saved.json()).toMatchObject({ code: 'agents_affected', format: 'openai' });
    });
  });

  describe('an opsiforce-* Linked account', () => {
    async function platformAdmin(): Promise<MemberFixture> {
      return addMember(app, await createTenant(app), [Perms.managePlatformModelProviders]);
    }

    it('is owned by the platform row, signed in by a platform admin, and served to an Organization that switches it on', async () => {
      const admin = await platformAdmin();
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      await holdEveryProjectKey();

      const created = await app.inject({
        method: 'POST',
        url: '/api/platform-model-providers',
        headers: admin.headers,
        payload: linkedAccount('capacity'),
      });

      expect(created.statusCode, created.body).toBe(201);
      expect(created.json<{ providers: unknown[] }>().providers).toContainEqual({
        name: 'opsiforce-capacity',
        baseFormat: 'openai',
        kind: 'linked-account',
        url: null,
        status: 'not-signed-in',
        fixed: false,
        notMetered: true,
        linkedAccountVendor: 'chatgpt',
      });
      expect((await rowsOf(seeded.admin)).find((row) => row.name === 'opsiforce-capacity')?.status).toBe(
        'not-signed-in'
      );
      expect(bifrost.providerNamed('opsiforce-capacity')?.keys).toMatchObject([
        { value: { value: expect.stringMatching(/^lap_/), type: 'plain_text' }, models: ['*'] },
      ]);
      expect(await startSignIn(seeded.admin, 'opsiforce-capacity')).toMatchObject({ statusCode: 404 });

      const started = await app.inject({
        method: 'POST',
        url: '/api/platform-model-providers/opsiforce-capacity/sign-in',
        headers: admin.headers,
      });
      expect(started.statusCode, started.body).toBe(200);
      chatgpt.replyToDevicePolls('approved');
      const status = await app.inject({
        method: 'GET',
        url: '/api/platform-model-providers/opsiforce-capacity/linked-account',
        headers: admin.headers,
      });
      expect(status.json()).toMatchObject({ state: 'connected', signedInAs: 'team@acme.test' });
      expect(chatProvidersOf(projectId)).not.toContain('opsiforce-capacity');
      const listed = await app.inject({ method: 'GET', url: '/api/platform-model-providers', headers: admin.headers });
      expect(listed.json<{ providers: Array<{ name: string; status: string }> }>().providers).toContainEqual(
        expect.objectContaining({ name: 'opsiforce-capacity', status: 'working' })
      );

      const switchedOn = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: seeded.admin.headers,
        payload: { providers: [{ name: 'opsiforce-capacity', chatEnabled: true, chatWeight: 3 }] },
      });

      expect(switchedOn.statusCode, switchedOn.body).toBe(200);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: 'opsiforce-capacity',
        weight: 3,
        ...OPENAI_FAMILY,
      });
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/api/platform-model-providers/opsiforce-capacity',
        headers: admin.headers,
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
    });
  });
});
