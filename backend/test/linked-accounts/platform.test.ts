import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { appliedModelCatalog, linkedAccounts, modelProviders, projectVirtualKeys } from '../../db/schema';
import { readModelCatalog } from '../../src/agent/agent-models';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { LinkedAccountsModule } from '../../src/linked-accounts/linked-accounts.module';
import { LinkedAccountsService } from '../../src/linked-accounts/linked-accounts.service';
import { ModelProviderKeyModelsService } from '../../src/model-provider/model-provider-key-models.service';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { ModelProvidersService } from '../../src/model-provider/model-provider.service';
import { DOCK_BASE_URL, startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
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

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const PROXY_URL = 'http://opsiforce-linked-account-proxy:8455/v1';
const SERVICE_TOKEN = 'linked-account-proxy-service-token';
const ENCRYPTION_KEY = 'a'.repeat(64);
const CATALOG_WIDE = { allowed_models: ['*'], key_ids: ['*'] };
const OPENAI_FAMILY = {
  allowed_models: [...servedModelsOf(BASE_FORMATS.openai), ...BASE_FORMATS.openai.imageModels],
  key_ids: ['*'],
};
const POLL_GAP_MS = 5_000;
const SIGN_IN_LIFETIME_MS = 15 * 60 * 1000;

interface LinkedAccountView {
  vendor: string;
  state: string;
  signedInAs: string | null;
  reason: string | null;
  signIn: { state: string; userCode?: string; verificationUrl?: string; expiresAt?: string } | null;
}

interface CredentialView {
  vendor: string;
  accessToken: string;
  accountId: string | null;
  expiresAt: string | null;
}

async function storedHash(): Promise<string | undefined> {
  const [row] = await db.select({ hash: linkedAccounts.callerSecretHash }).from(linkedAccounts);
  return row?.hash;
}

function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('the platform ChatGPT sign-in on custom-openai-1', () => {
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
    await holdEveryProjectKey();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(linkedAccounts);
    bifrost.setProviders(HELM_PROVIDERS);
    bifrost.becomeReachable();
    chatgpt.reset();
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await chatgpt.close();
  });

  async function platformAdmin(): Promise<MemberFixture> {
    const tenant = await createTenant(app);
    return addMember(app, tenant, ['can_manage_platform_model_providers']);
  }

  function startSignIn(admin: MemberFixture) {
    return app.inject({
      method: 'POST',
      url: '/api/platform-model-providers/custom-openai-1/sign-in',
      headers: admin.headers,
    });
  }

  async function statusOf(admin: MemberFixture): Promise<LinkedAccountView> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/platform-model-providers/custom-openai-1/linked-account',
      headers: admin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<LinkedAccountView>();
  }

  async function signIn(admin: MemberFixture): Promise<void> {
    expect((await startSignIn(admin)).statusCode).toBe(200);
    chatgpt.replyToDevicePolls('approved');
    expect((await statusOf(admin)).state).toBe('connected');
  }

  function callerSecret(): string {
    const [key] = bifrost.providerNamed('custom-openai-1')?.keys ?? [];
    if (!key) throw new Error('custom-openai-1 has no key in the fake Bifrost');
    return (key.value as { value: string }).value;
  }

  function fetchCredential(payload: Record<string, unknown>, token: string | null = SERVICE_TOKEN) {
    return app.inject({
      method: 'POST',
      url: '/api/internal/linked-accounts/credential',
      headers: token === null ? {} : { 'x-linked-account-proxy-token': token },
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

  async function holdEveryProjectKey(): Promise<void> {
    const keys = await db.select({ id: projectVirtualKeys.bifrostKeyId }).from(projectVirtualKeys);
    bifrost.holdVirtualKeys(keys.map((key) => key.id));
  }

  function chatProvidersOf(projectId: string): string[] {
    return bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider);
  }

  describe('device sign-in', () => {
    it('shows the device code, then turns Connected by itself and points custom-openai-1 at the proxy with a lap_ key', async () => {
      const admin = await platformAdmin();

      const started = await startSignIn(admin);

      expect(started.statusCode, started.body).toBe(200);
      expect(started.json()).toEqual({
        userCode: FAKE_USER_CODE,
        verificationUrl: `${chatgpt.issuer}/codex/device`,
        expiresAt: expect.any(String),
      });
      expect(Date.parse(started.json<{ expiresAt: string }>().expiresAt) - Date.now()).toBeGreaterThan(
        SIGN_IN_LIFETIME_MS - 5_000
      );
      expect(await statusOf(admin)).toMatchObject({
        vendor: 'chatgpt',
        state: 'awaiting-sign-in',
        signIn: { state: 'pending', userCode: FAKE_USER_CODE },
      });

      chatgpt.replyToDevicePolls('approved');
      advanceClock(POLL_GAP_MS);
      const connected = await statusOf(admin);

      expect(connected).toEqual({
        vendor: 'chatgpt',
        state: 'connected',
        signedInAs: 'platform@example.test',
        reason: null,
        signIn: null,
      });
      const provider = bifrost.providerNamed('custom-openai-1');
      expect(provider?.baseUrl).toBe(PROXY_URL);
      expect(provider?.updated).toMatchObject({
        network_config: { base_url: PROXY_URL, allow_private_network: true },
        custom_provider_config: { base_provider_type: 'openai', is_key_less: false },
      });
      expect(provider?.keys).toEqual([
        {
          id: expect.any(String),
          name: 'custom-openai-1-key',
          value: { value: expect.stringMatching(/^lap_[A-Za-z0-9_-]{40,}$/), type: 'plain_text' },
          models: ['*'],
          weight: 1,
          enabled: true,
        },
      ]);
      const [row] = await db.select().from(linkedAccounts);
      expect(row?.callerSecretHash).not.toContain(callerSecret());
      expect(JSON.stringify(row)).not.toContain('refresh-token');
    });

    it('lists custom-openai-1 as a platform Linked account once signed in', async () => {
      const admin = await platformAdmin();
      await signIn(admin);

      const res = await app.inject({ method: 'GET', url: '/api/platform-model-providers', headers: admin.headers });

      expect(res.json<{ providers: unknown[] }>().providers).toContainEqual({
        name: 'custom-openai-1',
        baseFormat: 'openai',
        kind: 'linked-account',
        url: null,
        status: 'working',
        fixed: false,
        notMetered: false,
        linkedAccountVendor: 'chatgpt',
      });
      expect(res.body).not.toContain(PROXY_URL);
    });

    it('never starts a sign-in on a status read, and checks with OpenAI at most once every 5 s', async () => {
      const admin = await platformAdmin();

      expect(await statusOf(admin)).toMatchObject({ state: 'awaiting-sign-in', signIn: null });
      expect(chatgpt.usercodeRequests).toBe(0);

      await startSignIn(admin);
      await statusOf(admin);
      await statusOf(admin);
      await Promise.all([statusOf(admin), statusOf(admin)]);
      expect(chatgpt.devicePolls).toBe(1);

      advanceClock(POLL_GAP_MS);
      await statusOf(admin);
      expect(chatgpt.devicePolls).toBe(2);
      expect(chatgpt.usercodeRequests).toBe(1);
    });

    it('waits through a 429 instead of failing the attempt', async () => {
      const admin = await platformAdmin();
      await startSignIn(admin);
      chatgpt.replyToDevicePolls('rate-limited');

      expect(await statusOf(admin)).toMatchObject({ state: 'awaiting-sign-in', signIn: { state: 'pending' } });
      advanceClock(POLL_GAP_MS);
      expect(await statusOf(admin)).toMatchObject({ signIn: { state: 'pending' } });
      expect(chatgpt.devicePolls).toBe(1);

      chatgpt.replyToDevicePolls('approved');
      advanceClock(60_000);
      expect(await statusOf(admin)).toMatchObject({ state: 'connected', signIn: null });
    });

    it('expires the attempt after 15 minutes without checking with OpenAI again', async () => {
      const admin = await platformAdmin();
      await startSignIn(admin);
      await statusOf(admin);
      const pollsBefore = chatgpt.devicePolls;
      chatgpt.replyToDevicePolls('approved');

      advanceClock(SIGN_IN_LIFETIME_MS);

      expect(await statusOf(admin)).toMatchObject({ state: 'awaiting-sign-in', signIn: { state: 'expired' } });
      expect(await statusOf(admin)).toMatchObject({ state: 'awaiting-sign-in', signIn: null });
      expect(chatgpt.devicePolls).toBe(pollsBefore);
      expect(bifrost.providerNamed('custom-openai-1')?.keys).toEqual([]);
    });

    it('creates custom-openai-1 in the gateway and as a platform provider when neither exists yet', async () => {
      const admin = await platformAdmin();
      const [platformRow] = await db
        .select()
        .from(modelProviders)
        .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, 'custom-openai-1')));
      await db.delete(modelProviders).where(eq(modelProviders.bifrostProvider, 'custom-openai-1'));
      bifrost.setProviders(['openai', 'anthropic']);

      try {
        const before = await app.inject({
          method: 'GET',
          url: '/api/platform-model-providers',
          headers: admin.headers,
        });
        expect(before.json<{ providers: unknown[] }>().providers).toContainEqual(
          expect.objectContaining({ name: 'custom-openai-1', status: 'missing', linkedAccountVendor: 'chatgpt' })
        );

        await signIn(admin);

        expect(bifrost.providerNamed('custom-openai-1')?.created).toMatchObject({
          provider: 'custom-openai-1',
          network_config: { base_url: PROXY_URL, allow_private_network: true },
          custom_provider_config: { base_provider_type: 'openai', allowed_requests: { list_models: false } },
        });
        expect(bifrost.providerNamed('custom-openai-1')?.keys).toMatchObject([
          { value: { value: expect.stringMatching(/^lap_/), type: 'plain_text' }, models: ['*'] },
        ]);
        const rows = await db
          .select({ chatEnabled: modelProviders.chatEnabled, chatWeight: modelProviders.chatWeight })
          .from(modelProviders)
          .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, 'custom-openai-1')));
        expect(rows).toEqual([{ chatEnabled: true, chatWeight: 1 }]);
      } finally {
        await db.delete(modelProviders).where(eq(modelProviders.bifrostProvider, 'custom-openai-1'));
        if (platformRow) await db.insert(modelProviders).values(platformRow);
      }
    });

    it('gives every existing Organization custom-openai-1 when it first creates the platform provider', async () => {
      const admin = await platformAdmin();
      const [platformRow] = await db
        .select()
        .from(modelProviders)
        .where(and(isNull(modelProviders.tenantId), eq(modelProviders.bifrostProvider, 'custom-openai-1')));
      await db.delete(modelProviders).where(eq(modelProviders.bifrostProvider, 'custom-openai-1'));
      bifrost.setProviders(['openai', 'anthropic']);

      try {
        const tenant = await createTenant(app);
        const projectId = await projectOf(tenant);
        const orgAdmin = await addMember(app, tenant, ['can_manage_tenant_model_providers']);
        expect(chatProvidersOf(projectId)).not.toContain('custom-openai-1');

        await signIn(admin);

        expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
          provider: 'custom-openai-1',
          weight: 1,
          ...OPENAI_FAMILY,
        });
        const page = await app.inject({ method: 'GET', url: '/api/model-providers', headers: orgAdmin.headers });
        expect(page.json<{ providers: unknown[] }>().providers).toContainEqual(
          expect.objectContaining({ name: 'custom-openai-1', chatEnabled: true, chatWeight: 1 })
        );
      } finally {
        await db.delete(modelProviders).where(eq(modelProviders.bifrostProvider, 'custom-openai-1'));
        if (platformRow) await db.insert(modelProviders).values(platformRow);
      }
    });

    it('puts custom-openai-1 back on the dock when its key cannot be written at sign-in', async () => {
      const admin = await platformAdmin();
      expect((await startSignIn(admin)).statusCode).toBe(200);
      chatgpt.replyToDevicePolls('approved');
      bifrost.refuseKeyWritesTo('custom-openai-1');

      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/platform-model-providers/custom-openai-1/linked-account',
          headers: admin.headers,
        });

        expect(res.statusCode).toBe(503);
        expect(bifrost.providerNamed('custom-openai-1')).toMatchObject({ baseUrl: DOCK_BASE_URL, keyLess: true });
        expect(bifrost.providerNamed('custom-openai-1')?.keys).toEqual([]);
      } finally {
        bifrost.refuseKeyWritesTo(null);
      }
      expect((await statusOf(admin)).state).toBe('connected');
    });

    it('stays signed in and served through the proxy when the chat keys cannot be rewritten at its first sign-in', async () => {
      const admin = await platformAdmin();
      await projectOf(await createTenant(app));
      expect((await startSignIn(admin)).statusCode).toBe(200);
      chatgpt.replyToDevicePolls('approved');
      bifrost.refuseProviderConfigWrites();

      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/platform-model-providers/custom-openai-1/linked-account',
          headers: admin.headers,
        });
        expect(res.statusCode).toBe(503);
        expect(res.json<{ message: string }>().message).toBe(
          'The account is signed in, but the model gateway did not take it yet; sign in again to retry'
        );
      } finally {
        bifrost.acceptProviderConfigWrites();
      }

      expect(bifrost.providerNamed('custom-openai-1')?.baseUrl).toBe(PROXY_URL);
      const credential = await fetchCredential({ caller_secret: callerSecret() });
      expect(credential.statusCode, credential.body).toBe(200);
      expect(chatgpt.devicePolls).toBe(1);
    });

    it('rewrites the chat keys again when an account Bifrost already serves through the proxy signs in again', async () => {
      const admin = await platformAdmin();
      const projectId = await projectOf(await createTenant(app));
      await signIn(admin);
      const keyId = bifrost.chatKeyOf(projectId).id;
      const writesBefore = bifrost.providerConfigWritesTo(keyId).length;
      const secret = callerSecret();

      await signIn(admin);

      expect(bifrost.providerConfigWritesTo(keyId).length).toBeGreaterThan(writesBefore);
      expect(callerSecret()).toBe(secret);
    });

    it('is refused without the platform permission', async () => {
      const tenant = await createTenant(app);
      const orgAdmin = await addMember(app, tenant, ['can_manage_tenant_model_providers']);

      const responses = await Promise.all([
        startSignIn(orgAdmin),
        app.inject({
          method: 'GET',
          url: '/api/platform-model-providers/custom-openai-1/linked-account',
          headers: orgAdmin.headers,
        }),
      ]);

      expect(responses.map((res) => res.statusCode)).toEqual([403, 403]);
      expect(chatgpt.usercodeRequests).toBe(0);
    });

    it('is offered only on custom-openai-1', async () => {
      const admin = await platformAdmin();

      const res = await app.inject({
        method: 'POST',
        url: '/api/platform-model-providers/openai/sign-in',
        headers: admin.headers,
      });

      expect(res.statusCode).toBe(400);
      expect(chatgpt.usercodeRequests).toBe(0);
    });
  });

  describe('chat keys', () => {
    it('keep custom-openai-1 while it still points at the Dock during the sign-in, so the cutover has no gap', async () => {
      const admin = await platformAdmin();
      const tenant = await createTenant(app);
      const projectId = await projectOf(tenant);
      const orgAdmin = await addMember(app, tenant, ['can_manage_tenant_model_providers']);

      await startSignIn(admin);
      await statusOf(admin);
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: orgAdmin.headers,
        payload: { providers: [{ name: 'custom-openai-1', chatEnabled: true, chatWeight: 2 }] },
      });

      expect(saved.statusCode, saved.body).toBe(200);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: 'custom-openai-1',
        weight: 2,
        ...CATALOG_WIDE,
      });
    });

    it('take a Linked account only while it is Connected, and every Organization shares the platform sign-in', async () => {
      const admin = await platformAdmin();
      const first = await createTenant(app);
      const second = await createTenant(app);
      bifrost.setProviders(['openai', 'anthropic']);
      const firstProject = await projectOf(first);
      const secondProject = await projectOf(second);
      expect(chatProvidersOf(firstProject)).not.toContain('custom-openai-1');

      await signIn(admin);

      for (const projectId of [firstProject, secondProject]) {
        expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
          provider: 'custom-openai-1',
          weight: 1,
          ...OPENAI_FAMILY,
        });
      }

      await db.update(linkedAccounts).set({ credential: null });
      const orgAdmin = await addMember(app, first, ['can_manage_tenant_model_providers']);
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/model-providers/formats/openai',
        headers: orgAdmin.headers,
        payload: { providers: [{ name: 'openai', chatEnabled: true, chatWeight: 0 }] },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(chatProvidersOf(firstProject)).not.toContain('custom-openai-1');
    });
  });

  describe('the credential route for the proxy', () => {
    it('returns the access token and account id for a known lap_ secret', async () => {
      const admin = await platformAdmin();
      await signIn(admin);

      const res = await fetchCredential({ caller_secret: callerSecret() });

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<CredentialView>()).toEqual({
        vendor: 'chatgpt',
        accessToken: chatgpt.issuedAccessTokens.at(-1),
        accountId: 'chatgpt-account-platform',
        expiresAt: expect.any(String),
      });
      expect(Date.parse(res.json<CredentialView>().expiresAt ?? '')).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
      expect(chatgpt.refreshRequests).toEqual([]);
    });

    it('refuses a missing or wrong service token and an unknown lap_ secret', async () => {
      const admin = await platformAdmin();
      await signIn(admin);

      const responses = await Promise.all([
        fetchCredential({ caller_secret: callerSecret() }, null),
        fetchCredential({ caller_secret: callerSecret() }, 'wrong-token'),
        fetchCredential({ caller_secret: `lap_${'x'.repeat(43)}` }),
        fetchCredential({}),
      ]);

      expect(responses.map((res) => res.statusCode)).toEqual([401, 401, 401, 401]);
      expect(responses.map((res) => res.body).join('')).not.toContain('chatgpt-account-platform');
    });

    it('refreshes on force_refresh and saves the rotated tokens', async () => {
      const admin = await platformAdmin();
      await signIn(admin);
      const signedInToken = chatgpt.issuedAccessTokens.at(-1);

      const forced = await fetchCredential({ caller_secret: callerSecret(), force_refresh: true });
      const again = await fetchCredential({ caller_secret: callerSecret(), force_refresh: true });

      expect(forced.statusCode, forced.body).toBe(200);
      expect(forced.json<CredentialView>().accessToken).not.toBe(signedInToken);
      expect(again.json<CredentialView>().accessToken).toBe(chatgpt.issuedAccessTokens.at(-1));
      expect(chatgpt.refreshRequests.map((request) => request.refreshToken)).toEqual([
        'refresh-token-1',
        'refresh-token-2',
      ]);
      expect(chatgpt.refreshRequests.every((request) => request.contentType?.startsWith('application/json'))).toBe(
        true
      );
    });

    it('refreshes only within 5 minutes of expiry', async () => {
      const admin = await platformAdmin();
      chatgpt.issueTokensLasting(20 * 60 * 1000);
      await signIn(admin);

      expect((await fetchCredential({ caller_secret: callerSecret() })).statusCode).toBe(200);
      expect(chatgpt.refreshRequests).toHaveLength(0);

      advanceClock(16 * 60 * 1000);
      const refreshed = await fetchCredential({ caller_secret: callerSecret() });

      expect(refreshed.json<CredentialView>().accessToken).toBe(chatgpt.issuedAccessTokens.at(-1));
      expect(chatgpt.refreshRequests).toHaveLength(1);
    });

    it('lets concurrent callers of an expiring token produce exactly one refresh with OpenAI', async () => {
      const admin = await platformAdmin();
      chatgpt.issueTokensLasting(2 * 60 * 1000);
      await signIn(admin);
      chatgpt.issueTokensLasting(60 * 60 * 1000);
      chatgpt.delayRefreshes(150);
      const secret = callerSecret();

      const responses = await Promise.all(Array.from({ length: 5 }, () => fetchCredential({ caller_secret: secret })));

      expect(responses.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(new Set(responses.map((res) => res.json<CredentialView>().accessToken))).toEqual(
        new Set([chatgpt.issuedAccessTokens.at(-1)])
      );
      expect(chatgpt.refreshRequests).toHaveLength(1);
    });
  });

  describe('at boot, after Bifrost lost the sign-in', () => {
    function repointAtBoot(): Promise<void> {
      return app.get(LinkedAccountsService).reconcileConnectedAccounts();
    }

    it('points a Connected custom-openai-1 reset to its Helm entry back at the proxy with a new lap_ key', async () => {
      const admin = await platformAdmin();
      const tenant = await createTenant(app);
      const projectId = await projectOf(tenant);
      await signIn(admin);
      const oldSecret = callerSecret();
      const oldHash = await storedHash();
      bifrost.restoreHelmEntry('custom-openai-1');
      const chatKeyId = bifrost.chatKeyOf(projectId).id;
      const chatKeyWritesBefore = bifrost.providerConfigWritesTo(chatKeyId).length;

      await repointAtBoot();

      const provider = bifrost.providerNamed('custom-openai-1');
      expect(provider?.baseUrl).toBe(PROXY_URL);
      expect(provider?.keyLess).toBe(false);
      expect(provider?.keys).toEqual([
        {
          id: expect.any(String),
          name: 'custom-openai-1-key',
          value: { value: expect.stringMatching(/^lap_[A-Za-z0-9_-]{40,}$/), type: 'plain_text' },
          models: ['*'],
          weight: 1,
          enabled: true,
        },
      ]);
      expect(callerSecret()).not.toBe(oldSecret);
      expect(await storedHash()).not.toBe(oldHash);
      expect(bifrost.providerConfigWritesTo(chatKeyId).length).toBeGreaterThan(chatKeyWritesBefore);
      expect(chatProvidersOf(projectId)).toContain('custom-openai-1');
      expect((await fetchCredential({ caller_secret: callerSecret() })).statusCode).toBe(200);
      expect((await fetchCredential({ caller_secret: oldSecret })).statusCode).toBe(401);
      expect((await statusOf(admin)).state).toBe('connected');
    });

    it('recreates a Connected custom-openai-1 Bifrost no longer has and gives it back to the chat keys', async () => {
      const admin = await platformAdmin();
      const tenant = await createTenant(app);
      const projectId = await projectOf(tenant);
      await signIn(admin);
      bifrost.loseProvider('custom-openai-1');
      expect(chatProvidersOf(projectId)).not.toContain('custom-openai-1');

      await repointAtBoot();

      expect(bifrost.providerNamed('custom-openai-1')?.baseUrl).toBe(PROXY_URL);
      expect(chatProvidersOf(projectId)).toContain('custom-openai-1');
      expect((await fetchCredential({ caller_secret: callerSecret() })).statusCode).toBe(200);
    });

    it('writes nothing for a Connected account Bifrost still serves through the proxy', async () => {
      const admin = await platformAdmin();
      await signIn(admin);
      const secret = callerSecret();
      const hash = await storedHash();
      const writesBefore = bifrost.writes.length;

      await repointAtBoot();

      expect(bifrost.writes.slice(writesBefore)).toEqual([]);
      expect(callerSecret()).toBe(secret);
      expect(await storedHash()).toBe(hash);
    });

    it('brings a Connected account created before image calls up to date and gives its keys the image models', async () => {
      const admin = await platformAdmin();
      const tenant = await createTenant(app);
      const projectId = await projectOf(tenant);
      await signIn(admin);
      const provider = bifrost.providerNamed('custom-openai-1');
      const written = (provider?.updated ?? provider?.created)?.custom_provider_config as Record<string, unknown>;
      written.allowed_requests = { ...(written.allowed_requests as Record<string, unknown>), image_generation: false };
      const secret = callerSecret();

      await repointAtBoot();

      const updated = bifrost.providerNamed('custom-openai-1')?.updated?.custom_provider_config as Record<
        string,
        unknown
      >;
      expect(updated.allowed_requests).toMatchObject({ image_generation: true, image_edit: true });
      expect(bifrost.providerNamed('custom-openai-1')?.baseUrl).toBe(PROXY_URL);
      expect(callerSecret()).toBe(secret);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: 'custom-openai-1',
        weight: 1,
        ...OPENAI_FAMILY,
      });
    });

    it('leaves a key rewrite that fails at boot to the catalog check, which then gives the keys the image models', async () => {
      const admin = await platformAdmin();
      const projectId = await projectOf(await createTenant(app));
      await signIn(admin);
      const keyModels = app.get(ModelProviderKeyModelsService);
      await db.delete(appliedModelCatalog);
      await keyModels.rewriteKeysForChangedCatalog(readModelCatalog());
      const provider = bifrost.providerNamed('custom-openai-1');
      const written = (provider?.updated ?? provider?.created)?.custom_provider_config as Record<string, unknown>;
      written.allowed_requests = { ...(written.allowed_requests as Record<string, unknown>), image_generation: false };
      await app.get(ModelProvidersService).lockAndRewriteKeysOfTenantsUsing('custom-openai-1');
      const chatKeyHasImageModels = () =>
        bifrost
          .chatKeyOf(projectId)
          .provider_configs.some(
            (config) => config.provider === 'custom-openai-1' && config.allowed_models?.includes('gpt-image-2')
          );
      expect(chatKeyHasImageModels()).toBe(false);

      bifrost.refuseProviderConfigWrites();
      try {
        await repointAtBoot();
      } finally {
        bifrost.acceptProviderConfigWrites();
      }
      const afterFailedBoot = chatKeyHasImageModels();
      await keyModels.rewriteKeysForChangedCatalog(readModelCatalog());

      expect(afterFailedBoot).toBe(false);
      expect(bifrost.chatKeyOf(projectId).provider_configs).toContainEqual({
        provider: 'custom-openai-1',
        weight: 1,
        ...OPENAI_FAMILY,
      });
    });

    it('leaves an account that is not signed in alone', async () => {
      const admin = await platformAdmin();
      await startSignIn(admin);
      bifrost.restoreHelmEntry('custom-openai-1');
      const hash = await storedHash();
      const writesBefore = bifrost.writes.length;

      await repointAtBoot();

      expect(bifrost.writes.slice(writesBefore)).toEqual([]);
      expect(bifrost.providerNamed('custom-openai-1')).toMatchObject({ baseUrl: DOCK_BASE_URL, keyLess: true });
      expect(await storedHash()).toBe(hash);
    });

    it('does not throw while Bifrost is unreachable, and repoints at the next boot', async () => {
      const admin = await platformAdmin();
      await signIn(admin);
      bifrost.restoreHelmEntry('custom-openai-1');
      bifrost.becomeUnreachable();

      await expect(repointAtBoot()).resolves.toBeUndefined();

      bifrost.becomeReachable();
      expect(bifrost.providerNamed('custom-openai-1')?.baseUrl).toBe(DOCK_BASE_URL);
      await repointAtBoot();
      expect(bifrost.providerNamed('custom-openai-1')?.baseUrl).toBe(PROXY_URL);
      expect((await fetchCredential({ caller_secret: callerSecret() })).statusCode).toBe(200);
    });
  });
});
