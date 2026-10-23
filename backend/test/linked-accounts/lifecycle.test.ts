import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { linkedAccounts, projectVirtualKeys } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { LinkedAccountsModule } from '../../src/linked-accounts/linked-accounts.module';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { startFakeChatGptAuth, type FakeChatGptAuth, type RefreshReply } from './support/fake-chatgpt-auth';
import {
  addMember,
  createAgent,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const HELM_PROVIDERS = ['openai', 'anthropic', 'custom-openai-1'];
const SERVICE_TOKEN = 'linked-account-proxy-service-token';
const ENCRYPTION_KEY = 'c'.repeat(64);
const POLL_GAP_MS = 5_000;
const FIRST_ACCOUNT = { email: 'team@acme.test', accountId: 'chatgpt-account-acme' };
const SECOND_ACCOUNT = { email: 'ops@acme.test', accountId: 'chatgpt-account-acme-ops' };
const WORKSPACE_ACCOUNT = { email: 'workspace@acme.test', accountId: 'chatgpt-account-acme-workspace' };

interface LinkedAccountView {
  vendor: string;
  state: string;
  signedInAs: string | null;
  reason: string | null;
  signIn: { state: string; userCode?: string } | null;
}

interface CredentialView {
  vendor: string;
  accessToken: string;
  accountId: string | null;
  expiresAt: string | null;
}

interface SeededTenant {
  tenant: TenantFixture;
  admin: MemberFixture;
}

type Scope = 'tenant' | 'platform';

const SCOPE_PATH: Record<Scope, string> = {
  tenant: '/api/model-providers',
  platform: '/api/platform-model-providers',
};

function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('the lifecycle of a Linked account', () => {
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
    chatgpt.signInAs(FIRST_ACCOUNT);
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
    return { tenant, admin: await addMember(app, tenant, ['can_manage_tenant_model_providers']) };
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

  async function added(seeded: SeededTenant, name = 'team-chatgpt'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/model-providers',
      headers: seeded.admin.headers,
      payload: { baseFormat: 'openai', kind: 'linked-account', vendor: 'chatgpt', name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return `${seeded.tenant.name}-${name}`;
  }

  function accountPath(scope: Scope, name: string): string {
    return `${SCOPE_PATH[scope]}/${encodeURIComponent(name)}`;
  }

  function startSignIn(admin: MemberFixture, name = 'team-chatgpt', scope: Scope = 'tenant') {
    return app.inject({ method: 'POST', url: `${accountPath(scope, name)}/sign-in`, headers: admin.headers });
  }

  async function statusOf(admin: MemberFixture, name = 'team-chatgpt', scope: Scope = 'tenant') {
    const res = await app.inject({
      method: 'GET',
      url: `${accountPath(scope, name)}/linked-account`,
      headers: admin.headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<LinkedAccountView>();
  }

  function pasteToken(admin: MemberFixture, accessToken: unknown, name = 'team-chatgpt', scope: Scope = 'tenant') {
    return app.inject({
      method: 'POST',
      url: `${accountPath(scope, name)}/access-token`,
      headers: admin.headers,
      payload: { accessToken },
    });
  }

  function disconnect(admin: MemberFixture, name = 'team-chatgpt', scope: Scope = 'tenant') {
    return app.inject({ method: 'POST', url: `${accountPath(scope, name)}/disconnect`, headers: admin.headers });
  }

  async function signIn(admin: MemberFixture, name = 'team-chatgpt', scope: Scope = 'tenant'): Promise<void> {
    const started = await startSignIn(admin, name, scope);
    expect(started.statusCode, started.body).toBe(200);
    chatgpt.replyToDevicePolls('approved');
    expect((await statusOf(admin, name, scope)).state).toBe('connected');
    chatgpt.replyToDevicePolls('pending');
  }

  async function cardStatusOf(admin: MemberFixture, name = 'team-chatgpt'): Promise<string | undefined> {
    const res = await app.inject({ method: 'GET', url: '/api/model-providers', headers: admin.headers });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ providers: Array<{ name: string; status: string }> }>().providers.find((row) => row.name === name)
      ?.status;
  }

  function chatProvidersOf(projectId: string): string[] {
    return bifrost.chatKeyOf(projectId).provider_configs.map((config) => config.provider);
  }

  function callerSecretOf(bifrostName: string): string {
    const [key] = bifrost.providerNamed(bifrostName)?.keys ?? [];
    if (!key) throw new Error(`${bifrostName} has no key in the fake Bifrost`);
    return (key.value as { value: string }).value;
  }

  function fetchCredential(callerSecret: string, forceRefresh = false) {
    return app.inject({
      method: 'POST',
      url: '/api/internal/linked-accounts/credential',
      headers: { 'x-linked-account-proxy-token': SERVICE_TOKEN },
      payload: { caller_secret: callerSecret, force_refresh: forceRefresh },
    });
  }

  async function credentialOf(callerSecret: string): Promise<CredentialView> {
    const res = await fetchCredential(callerSecret);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<CredentialView>();
  }

  describe('pasting an access token', () => {
    it('connects with a Business or Enterprise at-… token checked with whoami, and joins the chat keys', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      const accessToken = chatgpt.issuePersonalAccessToken(WORKSPACE_ACCOUNT);

      const res = await pasteToken(seeded.admin, accessToken);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        vendor: 'chatgpt',
        state: 'connected',
        signedInAs: null,
        reason: null,
        signIn: null,
      });
      expect(chatgpt.whoamiRequests).toBe(1);
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
      expect(await credentialOf(callerSecretOf(bifrostName))).toEqual({
        vendor: 'chatgpt',
        accessToken,
        accountId: WORKSPACE_ACCOUNT.accountId,
        expiresAt: null,
      });
      expect(chatgpt.refreshRequests).toEqual([]);
      expect(JSON.stringify(await db.select().from(linkedAccounts))).not.toContain(accessToken);
    });

    it('refuses an sk-… key with a pointer to Official API key, and a token OpenAI does not accept', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);

      const apiKey = await pasteToken(seeded.admin, 'sk-proj-abc123');
      const unknown = await pasteToken(seeded.admin, 'at-not-issued');
      const shapeless = await pasteToken(seeded.admin, 'hello');

      expect(apiKey.statusCode).toBe(400);
      expect(apiKey.json<{ message: string }>().message).toContain('Official API key');
      expect(unknown.statusCode).toBe(422);
      expect(shapeless.statusCode).toBe(400);
      expect(chatgpt.whoamiRequests).toBe(1);
      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'awaiting-sign-in' });
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);
    });
  });

  describe('signing in again while connected', () => {
    it('keeps the old sign-in serving until the new one completes, then replaces it with no gap in the chat keys', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      const callerSecret = callerSecretOf(bifrostName);
      const before = await credentialOf(callerSecret);
      const chatKeyId = bifrost.chatKeyOf(projectId).id;
      const writesBefore = bifrost.providerConfigWritesTo(chatKeyId).length;
      chatgpt.signInAs(SECOND_ACCOUNT);

      expect((await startSignIn(seeded.admin)).statusCode).toBe(200);

      expect(await statusOf(seeded.admin)).toMatchObject({
        state: 'connected',
        signedInAs: FIRST_ACCOUNT.email,
        signIn: { state: 'pending' },
      });
      expect(await credentialOf(callerSecret)).toEqual(before);
      expect(chatProvidersOf(projectId)).toContain(bifrostName);

      chatgpt.replyToDevicePolls('approved');
      advanceClock(POLL_GAP_MS);

      expect(await statusOf(seeded.admin)).toEqual({
        vendor: 'chatgpt',
        state: 'connected',
        signedInAs: SECOND_ACCOUNT.email,
        reason: null,
        signIn: null,
      });
      expect(callerSecretOf(bifrostName)).toBe(callerSecret);
      const after = await credentialOf(callerSecret);
      expect(after.accountId).toBe(SECOND_ACCOUNT.accountId);
      expect(after.accessToken).not.toBe(before.accessToken);
      const writesDuringSwitch = bifrost.providerConfigWritesTo(chatKeyId).slice(writesBefore);
      for (const write of writesDuringSwitch) {
        expect(JSON.stringify(write.body)).toContain(bifrostName);
      }
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
    });
  });

  describe('disconnecting', () => {
    it('revokes the sign-in at OpenAI, then deletes it and takes the row out of the chat keys', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      const refreshToken = chatgpt.currentRefreshToken();
      const callerSecret = callerSecretOf(bifrostName);

      const res = await disconnect(seeded.admin);

      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        vendor: 'chatgpt',
        state: 'awaiting-sign-in',
        signedInAs: null,
        reason: null,
        signIn: null,
      });
      expect(chatgpt.revokeRequests).toEqual([
        { token: refreshToken, tokenTypeHint: 'refresh_token', clientId: expect.any(String) },
      ]);
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);
      expect((await fetchCredential(callerSecret)).statusCode).toBe(409);
    });

    it('keeps the sign-in when OpenAI does not answer the revoke, so nothing is deleted before it is revoked', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      chatgpt.failRevokesWith(503);

      const res = await disconnect(seeded.admin);

      expect(res.statusCode).toBe(502);
      expect(chatgpt.revokeRequests).toHaveLength(1);
      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected' });
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
      expect((await fetchCredential(callerSecretOf(bifrostName))).statusCode).toBe(200);
    });

    it('revokes a pasted access token too', async () => {
      const seeded = await seededTenant();
      await added(seeded);
      const accessToken = chatgpt.issuePersonalAccessToken(WORKSPACE_ACCOUNT);
      await pasteToken(seeded.admin, accessToken);

      expect((await disconnect(seeded.admin)).statusCode).toBe(200);

      expect(chatgpt.revokeRequests).toEqual([
        { token: accessToken, tokenTypeHint: 'access_token', clientId: expect.any(String) },
      ]);
    });

    it('disconnects custom-openai-1 for every Organization when a platform admin disconnects it', async () => {
      const platformAdmin = await addMember(app, await createTenant(app), ['can_manage_platform_model_providers']);
      const tenant = await createTenant(app);
      bifrost.setProviders(['openai', 'anthropic']);
      const projectId = await projectOf(tenant);
      try {
        await signIn(platformAdmin, 'custom-openai-1', 'platform');
        const refreshToken = chatgpt.currentRefreshToken();

        const res = await disconnect(platformAdmin, 'custom-openai-1', 'platform');

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ state: 'awaiting-sign-in' });
        expect(chatgpt.revokeRequests.map((request) => request.token)).toEqual([refreshToken]);
        expect(chatProvidersOf(projectId)).not.toContain('custom-openai-1');
      } finally {
        await db.delete(linkedAccounts);
        bifrost.setProviders(HELM_PROVIDERS);
      }
    });

    it('is refused without can_manage_tenant_model_providers, like pasting a token', async () => {
      const seeded = await seededTenant();
      await added(seeded);
      await signIn(seeded.admin);
      const member = await addMember(app, seeded.tenant);

      const responses = await Promise.all([disconnect(member), pasteToken(member, 'at-anything')]);

      expect(responses.map((res) => res.statusCode)).toEqual([403, 403]);
      expect(chatgpt.revokeRequests).toEqual([]);
      expect(chatgpt.whoamiRequests).toBe(0);
    });
  });

  describe('removing a Linked account', () => {
    function remove(admin: MemberFixture) {
      return app.inject({ method: 'DELETE', url: '/api/model-providers/team-chatgpt', headers: admin.headers });
    }

    it('revokes its sign-in at OpenAI, then deletes its row, its sign-in and its Bifrost provider', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      const refreshToken = chatgpt.currentRefreshToken();
      const callerSecret = callerSecretOf(bifrostName);

      const res = await remove(seeded.admin);

      expect(res.statusCode, res.body).toBe(200);
      expect(chatgpt.revokeRequests).toEqual([
        { token: refreshToken, tokenTypeHint: 'refresh_token', clientId: expect.any(String) },
      ]);
      expect(res.json<{ providers: Array<{ name: string }> }>().providers.map((row) => row.name)).not.toContain(
        'team-chatgpt'
      );
      expect(bifrost.providerNamed(bifrostName)).toBeUndefined();
      const providerPath = `/api/providers/${bifrostName}`;
      const deletedAt = bifrost.requests.findIndex((req) => req.method === 'DELETE' && req.path === providerPath);
      const confirmedAt = bifrost.requests.findLastIndex((req) => req.method === 'GET' && req.path === providerPath);
      expect(deletedAt).toBeGreaterThan(-1);
      expect(confirmedAt).toBeGreaterThan(deletedAt);
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);
      expect((await fetchCredential(callerSecret)).statusCode).toBe(401);
    });

    it('keeps the row, the sign-in and the Bifrost provider when OpenAI does not answer the revoke', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      chatgpt.failRevokesWith(503);

      const res = await remove(seeded.admin);

      expect(res.statusCode).toBe(502);
      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected' });
      expect(bifrost.providerNamed(bifrostName)).toBeDefined();
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
      expect((await fetchCredential(callerSecretOf(bifrostName))).statusCode).toBe(200);
    });

    it('deletes one that was never signed in without calling OpenAI', async () => {
      const seeded = await seededTenant();
      await added(seeded);

      const res = await remove(seeded.admin);

      expect(res.statusCode, res.body).toBe(200);
      expect(chatgpt.revokeRequests).toEqual([]);
    });
  });

  describe('a sign-in OpenAI has ended', () => {
    const PERMANENT_REFRESH_FAILURES: Array<[RefreshReply, string]> = [
      ['refresh_token_reused', 'refresh_token_reused'],
      ['refresh_token_expired', 'refresh_token_expired'],
      ['refresh_token_invalidated', 'refresh_token_invalidated'],
      ['invalid_grant', 'invalid_grant'],
      ['unauthorized', '401'],
    ];

    it.each(PERMANENT_REFRESH_FAILURES)(
      'a %s refresh deletes the dead tokens, reads Needs sign-in again with the reason, and leaves the chat keys',
      async (reply, reason) => {
        const seeded = await seededTenant();
        const projectId = await projectOf(seeded.tenant);
        const bifrostName = await added(seeded);
        await signIn(seeded.admin);
        const callerSecret = callerSecretOf(bifrostName);
        chatgpt.replyToRefreshes(reply);

        const res = await fetchCredential(callerSecret, true);

        expect(res.statusCode).toBe(409);
        const status = await statusOf(seeded.admin);
        expect(status).toMatchObject({ state: 'needs-sign-in', signedInAs: null, signIn: null });
        expect(status.reason).toContain(reason);
        expect(await cardStatusOf(seeded.admin)).toBe('needs-sign-in');
        expect(chatProvidersOf(projectId)).not.toContain(bifrostName);
        expect((await fetchCredential(callerSecret)).statusCode).toBe(409);
        expect(chatgpt.refreshRequests).toHaveLength(1);
      }
    );

    it('is repaired by signing in again, which clears the reason and rejoins the chat keys', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      chatgpt.replyToRefreshes('refresh_token_reused');
      await fetchCredential(callerSecretOf(bifrostName), true);
      chatgpt.replyToRefreshes('rotate');

      await signIn(seeded.admin);

      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected', reason: null });
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
      expect((await fetchCredential(callerSecretOf(bifrostName))).statusCode).toBe(200);
    });

    it('treats an expired pasted access token as ended', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      const accessToken = chatgpt.issuePersonalAccessToken(WORKSPACE_ACCOUNT);
      await pasteToken(seeded.admin, accessToken);
      chatgpt.endPersonalAccessToken(accessToken);

      const res = await fetchCredential(callerSecretOf(bifrostName), true);

      expect(res.statusCode).toBe(409);
      const status = await statusOf(seeded.admin);
      expect(status.state).toBe('needs-sign-in');
      expect(status.reason).toContain('401');
      expect(chatProvidersOf(projectId)).not.toContain(bifrostName);
    });

    it('applies to platform Linked accounts: custom-openai-1 leaves every Organization’s chat keys', async () => {
      const platformAdmin = await addMember(app, await createTenant(app), ['can_manage_platform_model_providers']);
      const tenant = await createTenant(app);
      bifrost.setProviders(['openai', 'anthropic']);
      const projectId = await projectOf(tenant);
      try {
        await signIn(platformAdmin, 'custom-openai-1', 'platform');
        expect(chatProvidersOf(projectId)).toContain('custom-openai-1');
        chatgpt.replyToRefreshes('refresh_token_invalidated');

        expect((await fetchCredential(callerSecretOf('custom-openai-1'), true)).statusCode).toBe(409);

        const status = await statusOf(platformAdmin, 'custom-openai-1', 'platform');
        expect(status.state).toBe('needs-sign-in');
        expect(status.reason).toContain('refresh_token_invalidated');
        expect(chatProvidersOf(projectId)).not.toContain('custom-openai-1');
      } finally {
        await db.delete(linkedAccounts);
        bifrost.setProviders(HELM_PROVIDERS);
      }
    });
  });

  describe('a Vendor 5xx', () => {
    it('keeps the tokens on a failed refresh and fails only that request', async () => {
      const seeded = await seededTenant();
      const projectId = await projectOf(seeded.tenant);
      const bifrostName = await added(seeded);
      await signIn(seeded.admin);
      const callerSecret = callerSecretOf(bifrostName);
      chatgpt.replyToRefreshes('server-error');

      expect((await fetchCredential(callerSecret, true)).statusCode).toBe(502);

      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected', reason: null });
      expect(chatProvidersOf(projectId)).toContain(bifrostName);
      chatgpt.replyToRefreshes('rotate');
      expect((await fetchCredential(callerSecret, true)).statusCode).toBe(200);
    });

    it('keeps a pasted access token when whoami fails', async () => {
      const seeded = await seededTenant();
      const bifrostName = await added(seeded);
      await pasteToken(seeded.admin, chatgpt.issuePersonalAccessToken(WORKSPACE_ACCOUNT));
      chatgpt.failWhoamisWith(503);

      expect((await fetchCredential(callerSecretOf(bifrostName))).statusCode).toBe(502);

      expect(await statusOf(seeded.admin)).toMatchObject({ state: 'connected' });
      chatgpt.failWhoamisWith(null);
      expect((await fetchCredential(callerSecretOf(bifrostName))).statusCode).toBe(200);
    });
  });
});
