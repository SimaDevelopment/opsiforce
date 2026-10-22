import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { linkedAccounts, modelProviders } from '../../db/schema';
import { BifrostService } from '../../src/bifrost/bifrost.service';
import { encryptResourceValue, decryptResourceValue, asEncryptedResourceValue } from '../../src/common/secret-crypto';
import { LinkedAccountsModule } from '../../src/linked-accounts/linked-accounts.module';
import { ModelProvidersModule } from '../../src/model-provider/model-provider.module';
import { Perms } from '../../src/permission/permission.constants';
import { startFakeBifrost, type FakeBifrost } from '../support/fake-bifrost';
import { addMember, createTenant, type MemberFixture } from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';
import { startFakeChatGptAuth, type FakeChatGptAuth } from './support/fake-chatgpt-auth';

const SERVICE_TOKEN = 'linked-account-proxy-service-token';
const ENCRYPTION_KEY = 'd'.repeat(64);
const ACME_ACCOUNT = { email: 'team@acme.test', accountId: 'chatgpt-account-acme' };
const GLOBEX_ACCOUNT = { email: 'team@globex.test', accountId: 'chatgpt-account-globex' };

interface ConnectedAccount {
  ownerId: string;
  bifrostName: string;
  accessToken: string;
  admin: MemberFixture;
}

async function storedCredentialOf(ownerId: string): Promise<string> {
  const [row] = await db
    .select({ credential: linkedAccounts.credential })
    .from(linkedAccounts)
    .where(eq(linkedAccounts.modelProviderId, ownerId));
  if (!row?.credential) throw new Error(`${ownerId} has no stored credential`);
  return row.credential;
}

describe('the sealed sign-in of a Linked account', () => {
  let bifrost: FakeBifrost;
  let chatgpt: FakeChatGptAuth;
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;

  function env(): Record<string, string> {
    return {
      ...bifrost.env,
      EXTERNAL_SERVICES_ENCRYPTION_KEY: ENCRYPTION_KEY,
      LINKED_ACCOUNT_PROXY_SERVICE_TOKEN: SERVICE_TOKEN,
    };
  }

  function boot(): Promise<PublicApiTestApp> {
    return createPublicApiTestApp(env(), [ModelProvidersModule, LinkedAccountsModule], [BifrostService]);
  }

  beforeAll(async () => {
    bifrost = await startFakeBifrost();
    chatgpt = await startFakeChatGptAuth();
    harness = await boot();
    app = harness.app;
  });

  afterAll(async () => {
    await harness.close();
    await bifrost.close();
    await chatgpt.close();
  });

  async function connected(account: { email: string; accountId: string }): Promise<ConnectedAccount> {
    const tenant = await createTenant(app);
    const admin = await addMember(app, tenant, [Perms.manageTenantModelProviders]);
    const added = await app.inject({
      method: 'POST',
      url: '/api/model-providers',
      headers: admin.headers,
      payload: { baseFormat: 'openai', kind: 'linked-account', vendor: 'chatgpt', name: 'team-chatgpt' },
    });
    expect(added.statusCode, added.body).toBe(201);
    const bifrostName = `${tenant.name}-team-chatgpt`;
    const accessToken = chatgpt.issuePersonalAccessToken(account);
    const pasted = await app.inject({
      method: 'POST',
      url: '/api/model-providers/team-chatgpt/access-token',
      headers: admin.headers,
      payload: { accessToken },
    });
    expect(pasted.statusCode, pasted.body).toBe(200);
    const [owner] = await db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.bifrostProvider, bifrostName));
    if (!owner) throw new Error(`${bifrostName} has no model provider row`);
    return { ownerId: owner.id, bifrostName, accessToken, admin };
  }

  function callerSecretOf(bifrostName: string): string {
    const [key] = bifrost.providerNamed(bifrostName)?.keys ?? [];
    if (!key) throw new Error(`${bifrostName} has no key in the fake Bifrost`);
    return (key.value as { value: string }).value;
  }

  function fetchCredential(on: NestFastifyApplication, bifrostName: string) {
    return on.inject({
      method: 'POST',
      url: '/api/internal/linked-accounts/credential',
      headers: { 'x-linked-account-proxy-token': SERVICE_TOKEN },
      payload: { caller_secret: callerSecretOf(bifrostName), force_refresh: false },
    });
  }

  it('does not open when copied onto another Linked account', async () => {
    const acme = await connected(ACME_ACCOUNT);
    const globex = await connected(GLOBEX_ACCOUNT);

    await db
      .update(linkedAccounts)
      .set({ credential: await storedCredentialOf(acme.ownerId) })
      .where(eq(linkedAccounts.modelProviderId, globex.ownerId));

    const copied = await fetchCredential(app, globex.bifrostName);
    expect(copied.statusCode).toBe(500);
    expect(copied.body).not.toContain(acme.accessToken);
    const own = await fetchCredential(app, acme.bifrostName);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json<{ accessToken: string }>().accessToken).toBe(acme.accessToken);
  });

  it('sealed before it was bound to its place is re-sealed at boot and keeps serving', async () => {
    const acme = await connected(ACME_ACCOUNT);
    const unbound = JSON.stringify(
      encryptResourceValue(Buffer.from(ENCRYPTION_KEY, 'hex'), { accessToken: acme.accessToken, refreshToken: null })
    );
    await db
      .update(linkedAccounts)
      .set({ credential: unbound })
      .where(eq(linkedAccounts.modelProviderId, acme.ownerId));

    const rebooted = await boot();
    try {
      const resealed = await storedCredentialOf(acme.ownerId);
      expect(resealed).not.toBe(unbound);
      expect(() =>
        decryptResourceValue(Buffer.from(ENCRYPTION_KEY, 'hex'), asEncryptedResourceValue(JSON.parse(resealed)))
      ).toThrow();
      const served = await fetchCredential(rebooted.app, acme.bifrostName);
      expect(served.statusCode, served.body).toBe(200);
      expect(served.json<{ accessToken: string }>().accessToken).toBe(acme.accessToken);
    } finally {
      await rebooted.close();
    }
  });
});
