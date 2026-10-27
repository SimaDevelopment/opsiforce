import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';

let harness: DomainTestHarness;

beforeAll(async () => {
  vi.stubEnv('MANAGED_OIDC_CLIENT_SECRET', 'managed-secret');
  vi.stubEnv('MANAGED_OIDC_ISSUER_URL', 'https://sso.example-org.test/realms/apps');
  harness = await createDomainTestingModule();
});

afterAll(async () => {
  await harness.close();
  vi.unstubAllEnvs();
});

const customerIdp = {
  clientId: 'customer-app',
  clientSecret: 'customer-secret',
  discoveryUrl: 'https://idp.example-org.test/.well-known/openid-configuration',
};

async function newTenant(): Promise<{ tenantId: string; tenantName: string }> {
  const tenant = await harness.tenants.getOrCreateTenant(`duplicate-auth-${randomUUID()}`);
  return { tenantId: tenant.id, tenantName: tenant.name };
}

describe('Duplicate keeps App Auth on the copy', () => {
  it("gates a copy of a manual App with the source's sign-in settings", async () => {
    const { tenantId } = await newTenant();
    const source = await harness.projects.create({ title: 'Protected' }, tenantId);
    await harness.projects.updateAuth(
      source.id,
      source.id,
      { mode: 'manual', config: customerIdp, bypassAuthPaths: ['/health'] },
      tenantId
    );

    const copy = await harness.projects.duplicate(source.id, tenantId, undefined, null);

    expect(copy.authMode).toBe('manual');
    expect(harness.fakes.projectAuth.gateOf(copy.id)).toEqual({
      mode: 'manual',
      config: customerIdp,
      bypassAuthPaths: ['/health'],
    });
  });

  it("gates a copy of a managed App whose gate is gone with the Organization's managed sign-in", async () => {
    const { tenantId, tenantName } = await newTenant();
    const source = await harness.projects.create({ title: 'Managed' }, tenantId);
    await harness.projects.updateAuth(
      source.id,
      source.id,
      { mode: 'managed', bypassAuthPaths: ['/webhooks'] },
      tenantId
    );
    harness.fakes.projectAuth.loseGate(source.id);

    const copy = await harness.projects.duplicate(source.id, tenantId, undefined, null);

    expect(copy.authMode).toBe('managed');
    expect(harness.fakes.projectAuth.gateOf(copy.id)).toEqual({ mode: 'managed', tenantName, bypassAuthPaths: [] });
  });

  it('refuses to make a copy of a manual App whose sign-in settings cannot be read', async () => {
    const { tenantId } = await newTenant();
    const source = await harness.projects.create({ title: 'Lost gate' }, tenantId);
    await harness.projects.updateAuth(source.id, source.id, { mode: 'manual', config: customerIdp }, tenantId);
    harness.fakes.projectAuth.loseGate(source.id);

    await expect(harness.projects.duplicate(source.id, tenantId, undefined, null)).rejects.toThrow('source middleware');

    expect((await harness.projects.findAll(tenantId)).map((project) => project.id)).toEqual([source.id]);
  });

  it('leaves a copy of a public App public', async () => {
    const { tenantId } = await newTenant();
    const source = await harness.projects.create({ title: 'Open' }, tenantId);

    const copy = await harness.projects.duplicate(source.id, tenantId, undefined, null);

    expect(copy.authMode).toBe('public');
    expect(harness.fakes.projectAuth.gateOf(copy.id)).toBeUndefined();
  });
});
