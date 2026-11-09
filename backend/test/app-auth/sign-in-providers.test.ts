import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { projectEnvironments, signInProviders } from '../../db/schema';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from '../../src/environment/environment.service';
import { ProjectAuthService } from '../../src/project/project-auth.service';
import { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { PublishService } from '../../src/publish/publish.service';
import { PublicUrlService } from '../../src/project-environment/public-url.service';
import { ProjectService } from '../../src/project/project.service';
import { SignInProvidersModule } from '../../src/sign-in-provider/sign-in-provider.module';
import { FakeQueue, type FakeProjectAuthService } from '../support/infra-fakes';
import {
  addMember,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../support/project-fixtures';
import { createPublicApiTestApp, type PublicApiTestApp } from '../public-api/support/app';

const ENTRA = {
  name: 'Example staff',
  discoveryUrl: 'https://login.microsoftonline.com/example-org/v2.0',
  clientId: 'example-client',
  clientSecret: 'example-secret-1',
};

interface ProviderView {
  id: string;
  name: string;
  discoveryUrl: string;
  redirectUri: string;
  requiredClaimName: string | null;
  requiredClaimValues: string[];
  groupsClaim: string | null;
  environmentCount: number;
}

async function defaultEnvironmentOf(projectId: string): Promise<string> {
  const [row] = await db
    .select({ id: projectEnvironments.id })
    .from(projectEnvironments)
    .where(eq(projectEnvironments.projectId, projectId));
  return row.id;
}

describe('Organization sign-in providers', () => {
  let harness: PublicApiTestApp;
  let app: NestFastifyApplication;
  let auth: FakeProjectAuthService;

  beforeAll(async () => {
    harness = await createPublicApiTestApp({}, [SignInProvidersModule]);
    app = harness.app;
    auth = app.get<typeof ProjectAuthService, FakeProjectAuthService>(ProjectAuthService);
  });

  afterAll(async () => {
    await harness.close();
  });

  function adminOf(tenant: TenantFixture): Promise<MemberFixture> {
    return addMember(app, tenant, ['can_manage_tenant_sign_in_providers']);
  }

  async function createProvider(admin: MemberFixture, payload: Record<string, unknown> = ENTRA): Promise<ProviderView> {
    const res = await app.inject({ method: 'POST', url: '/api/sign-in-providers', headers: admin.headers, payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<ProviderView>();
  }

  function patchProvider(admin: MemberFixture, id: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/api/sign-in-providers/${id}`, headers: admin.headers, payload });
  }

  async function protectedApp(tenant: TenantFixture, provider: ProviderView, dto: Record<string, unknown> = {}) {
    const projectId = await createProject(app, tenant);
    const envId = await defaultEnvironmentOf(projectId);
    await app
      .get(ProjectService)
      .updateAuth(projectId, envId, { mode: 'provider', signInProviderId: provider.id, ...dto }, tenant.tenantId);
    return { projectId, envId };
  }

  it('gives one redirect URI for every App, writes its callback route, and never returns the secret', async () => {
    const created = await createProvider(await adminOf(await createTenant(app)));

    expect(created.redirectUri).toBe(`https://auth.apps.example.test/p/${created.id}/oidc/callback`);
    expect(auth.callsTo('applySignInHost').at(-1)?.args).toMatchObject({
      providerId: created.id,
      clientSecret: ENTRA.clientSecret,
    });
    expect(created.discoveryUrl).toBe(`${ENTRA.discoveryUrl}/.well-known/openid-configuration`);
    expect(JSON.stringify(created)).not.toContain(ENTRA.clientSecret);
    const [row] = await db.select().from(signInProviders).where(eq(signInProviders.id, created.id));
    expect(row.clientSecret).not.toContain(ENTRA.clientSecret);
  });

  it('shows names only to project auth editors and nothing to plain members', async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant));
    const editor = await addMember(app, tenant, ['can_manage_project_auth_settings']);
    const member = await addMember(app, tenant);

    const options = await app.inject({ method: 'GET', url: '/api/sign-in-providers/options', headers: editor.headers });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json()).toEqual([{ id: provider.id, name: ENTRA.name }]);
    const list = await app.inject({ method: 'GET', url: '/api/sign-in-providers', headers: editor.headers });
    expect(list.statusCode).toBe(403);
    const memberOptions = await app.inject({
      method: 'GET',
      url: '/api/sign-in-providers/options',
      headers: member.headers,
    });
    expect(memberOptions.statusCode).toBe(403);
  });

  it("hides one Organization's providers from another", async () => {
    const provider = await createProvider(await adminOf(await createTenant(app)));
    const strangerTenant = await createTenant(app);
    const stranger = await adminOf(strangerTenant);

    expect((await patchProvider(stranger, provider.id, { clientSecret: 'stolen' })).statusCode).toBe(404);
    await expect(protectedApp(strangerTenant, provider)).rejects.toThrow('not found');
  });

  it('rejects an invalid URL, a duplicate name and a claim name the plugin cannot read', async () => {
    const admin = await adminOf(await createTenant(app));
    await createProvider(admin);
    const cases = [
      { ...ENTRA, name: 'Broken', discoveryUrl: 'not a url' },
      ENTRA,
      { ...ENTRA, name: 'Spaced', requiredClaimName: 'my groups', requiredClaimValues: ['a'] },
      { ...ENTRA, name: 'Quoted', requiredClaimName: "roles']", requiredClaimValues: ['a'] },
      { ...ENTRA, name: 'Templated', groupsClaim: '{{ .claims }}' },
    ];
    const codes = [];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/sign-in-providers', headers: admin.headers, payload });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([400, 409, 400, 400, 400]);
  });

  it("accepts every provider's claim shapes, including a claim that only has to exist", async () => {
    const admin = await adminOf(await createTenant(app));
    const shapes: Array<[string, string[]]> = [
      ['cognito:groups', ['staff']],
      ['urn:zitadel:iam:org:project:roles', []],
      ['https://example.com/roles', ['admin']],
      ['realm_access.roles', ['example-org']],
    ];
    for (const [requiredClaimName, requiredClaimValues] of shapes) {
      const created = await createProvider(admin, {
        ...ENTRA,
        name: requiredClaimName,
        requiredClaimName,
        requiredClaimValues,
      });
      expect(created).toMatchObject({ requiredClaimName, requiredClaimValues });
    }
  });

  it('sends the groups claim it names to every App, and stops when it is emptied', async () => {
    const tenant = await createTenant(app);
    const admin = await adminOf(tenant);
    const provider = await createProvider(admin, { ...ENTRA, groupsClaim: 'realm_access.roles' });
    expect(provider).toMatchObject({ groupsClaim: 'realm_access.roles' });
    const { envId } = await protectedApp(tenant, provider);
    const groupsClaimSent = () =>
      auth.callsTo('applyProvider').findLast((c) => c.args.environmentId === envId)?.args.groupsClaim;
    expect(groupsClaimSent()).toBe('realm_access.roles');

    const cleared = await patchProvider(admin, provider.id, { groupsClaim: '' });
    expect(cleared.json<ProviderView>()).toMatchObject({ groupsClaim: null });
    expect(groupsClaimSent()).toBeNull();
  });

  it("writes the App's plugin middleware from the provider, with the environment's own forwarding and bypass paths", async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant), {
      ...ENTRA,
      requiredClaimName: 'groups',
      requiredClaimValues: ['staff'],
    });
    const { projectId, envId } = await protectedApp(tenant, provider, { bypassAuthPaths: ['/health'] });

    expect(auth.callsTo('applyProvider').filter((c) => c.args.environmentId === envId)).toEqual([
      {
        method: 'applyProvider',
        args: {
          environmentId: envId,
          shortId: (await app.get(ProjectEnvironmentService).findById(envId)).shortId,
          providerId: provider.id,
          clientSecret: ENTRA.clientSecret,
          requiredClaim: { name: 'groups', values: ['staff'] },
          groupsClaim: null,
          forwardAccessToken: false,
          bypassAuthPaths: ['/health'],
        },
      },
    ]);
    expect(await app.get(ProjectService).getAuth(projectId, envId, tenant.tenantId)).toMatchObject({
      mode: 'provider',
      signInProviderId: provider.id,
    });
  });

  it('refuses an unknown mode and the provider mode without a provider', async () => {
    const tenant = await createTenant(app);
    const projectId = await createProject(app, tenant);
    const envId = await defaultEnvironmentOf(projectId);
    const projects = app.get(ProjectService);
    await expect(projects.updateAuth(projectId, envId, { mode: 'managed' as never }, tenant.tenantId)).rejects.toThrow(
      'Unknown or unavailable auth mode'
    );
    await expect(projects.updateAuth(projectId, envId, { mode: 'provider' }, tenant.tenantId)).rejects.toThrow(
      'signInProviderId is required'
    );
  });

  it("never carries the provider's secret into a manual configuration that names its own identity provider", async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant));
    const { projectId, envId } = await protectedApp(tenant, provider);

    await expect(
      app
        .get(ProjectService)
        .updateAuth(
          projectId,
          envId,
          { mode: 'manual', config: { clientId: 'mine', discoveryUrl: 'https://attacker.example' } },
          tenant.tenantId
        )
    ).rejects.toThrow('clientSecret is required');
    expect(auth.callsTo('apply').filter((c) => c.args.environmentId === envId)).toEqual([]);
  });

  it('refuses a manual save without a secret that waited behind a switch to a provider', async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant));
    const projectId = await createProject(app, tenant);
    const envId = await defaultEnvironmentOf(projectId);
    const projects = app.get(ProjectService);
    await projects.updateAuth(
      projectId,
      envId,
      {
        mode: 'manual',
        config: { clientId: 'mine', clientSecret: 'mine', discoveryUrl: 'https://id.example-org.com' },
      },
      tenant.tenantId
    );
    const manualWrites = () => auth.callsTo('apply').filter((c) => c.args.environmentId === envId).length;
    const before = manualWrites();

    const hold = auth.holdNextApplyFor(envId);
    const toProvider = projects.updateAuth(
      projectId,
      envId,
      { mode: 'provider', signInProviderId: provider.id },
      tenant.tenantId
    );
    await hold.reached;
    const keepSecret = projects.updateAuth(
      projectId,
      envId,
      { mode: 'manual', config: { clientId: 'mine', discoveryUrl: 'https://attacker.example' } },
      tenant.tenantId
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    hold.release();

    await expect(keepSecret).rejects.toThrow('clientSecret is required');
    await toProvider;
    expect(manualWrites()).toBe(before);
    expect(auth.gateOf(envId)).toMatchObject({ mode: 'provider', providerId: provider.id });
  });

  it('gives a duplicate the same provider and a copy of its gate', async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant));
    const { projectId, envId } = await protectedApp(tenant, provider);

    const copy = await app.get(ProjectService).duplicate(projectId, tenant.tenantId, undefined, null);
    const [copied] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.id, copy.id));
    expect(copied).toMatchObject({ authMode: 'provider', signInProviderId: provider.id });
    expect(auth.callsTo('inheritAuth').filter((c) => c.args.environmentId === copy.id)).toEqual([
      {
        method: 'inheritAuth',
        args: { fromEnvironmentId: envId, environmentId: copy.id, shortId: copied.shortId },
      },
    ]);
  });

  it('names the provider the copied middleware really uses, even when the source row is stale', async () => {
    const tenant = await createTenant(app);
    const admin = await adminOf(tenant);
    const used = await createProvider(admin);
    const stale = await createProvider(admin, { ...ENTRA, name: 'Stale' });
    const { projectId, envId } = await protectedApp(tenant, used);
    await db.update(projectEnvironments).set({ signInProviderId: stale.id }).where(eq(projectEnvironments.id, envId));

    const copy = await app.get(ProjectService).duplicate(projectId, tenant.tenantId, undefined, null);
    const [copied] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.id, copy.id));
    expect(copied).toMatchObject({ authMode: 'provider', signInProviderId: used.id });
  });

  it('seeds a published environment from what Development uses when the publish runs, not when it was queued', async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant));
    const development = await protectedApp(tenant, provider);
    const queued = await protectedApp(tenant, provider);
    const projects = app.get(ProjectService);
    await projects.updateAuth(development.projectId, development.envId, { mode: 'public' }, tenant.tenantId);

    await projects.inheritAuth(
      { id: development.envId },
      await app.get(ProjectEnvironmentService).findById(queued.envId)
    );
    expect(auth.gateOf(queued.envId)).toBeUndefined();
    const publishedId = queued.envId;
    const [published] = await db.select().from(projectEnvironments).where(eq(projectEnvironments.id, publishedId));
    expect(published).toMatchObject({ authMode: 'public', signInProviderId: null });
  });

  it('carries the provider to a newly published environment', async () => {
    const tenant = await createTenant(app);
    const provider = await createProvider(await adminOf(tenant));
    const { projectId } = await protectedApp(tenant, provider);
    const production = await app
      .get(EnvironmentService)
      .create(tenant.tenantId, { name: 'Live', slug: `live-${randomUUID().slice(0, 6)}` });
    const publisher = new PublishService(
      app.get(ConfigService),
      app.get(EnvironmentService),
      app.get(ProjectEnvironmentService),
      app.get(PublicUrlService),
      app.get(ProjectService),
      {} as never,
      new FakeQueue() as never
    );

    const job = await publisher.publish(projectId, tenant.tenantId, { environmentId: production.id });
    const [published] = await db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, job.projectEnvironmentId));
    expect(published).toMatchObject({ authMode: 'provider', signInProviderId: provider.id });
  });

  it('keeps an App on the provider its owner switched to while the old provider was being saved', async () => {
    const tenant = await createTenant(app);
    const admin = await adminOf(tenant);
    const oldProvider = await createProvider(admin);
    const newProvider = await createProvider(admin, { ...ENTRA, name: 'Example contractors' });
    const { projectId, envId } = await protectedApp(tenant, oldProvider);

    const hold = auth.holdNextApplyFor(envId);
    const save = patchProvider(admin, oldProvider.id, { clientSecret: 'example-secret-2' });
    await hold.reached;
    const switched = app
      .get(ProjectService)
      .updateAuth(projectId, envId, { mode: 'provider', signInProviderId: newProvider.id }, tenant.tenantId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    hold.release();
    expect((await save).statusCode).toBe(200);
    await switched;

    expect(auth.gateOf(envId)).toMatchObject({ mode: 'provider', providerId: newProvider.id });
    const [row] = await db
      .select({ signInProviderId: projectEnvironments.signInProviderId })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, envId));
    expect(row.signInProviderId).toBe(newProvider.id);
  });

  it('rewrites every App that uses a provider when it changes, and blocks deleting a provider in use', async () => {
    const tenant = await createTenant(app);
    const admin = await adminOf(tenant);
    const provider = await createProvider(admin);
    const first = await protectedApp(tenant, provider);
    const second = await protectedApp(tenant, provider);

    const rotated = await patchProvider(admin, provider.id, {
      clientSecret: 'example-secret-2',
      requiredClaimName: 'groups',
      requiredClaimValues: ['staff'],
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json()).toMatchObject({ environmentCount: 2 });
    expect(auth.callsTo('applySignInHost').at(-1)?.args).toMatchObject({ clientSecret: 'example-secret-2' });
    for (const envId of [first.envId, second.envId]) {
      expect(auth.callsTo('applyProvider').findLast((c) => c.args.environmentId === envId)?.args).toMatchObject({
        clientSecret: 'example-secret-2',
        requiredClaim: { name: 'groups', values: ['staff'] },
      });
    }

    auth.refuseApplyFor(first.envId);
    const partly = await patchProvider(admin, provider.id, { clientSecret: 'example-secret-3' });
    expect(partly.statusCode).toBe(503);
    expect(partly.json().message).toContain('1 of 2');
    expect(
      auth.callsTo('applyProvider').findLast((c) => c.args.environmentId === second.envId)?.args.clientSecret
    ).toBe('example-secret-3');

    const remove = () =>
      app.inject({ method: 'DELETE', url: `/api/sign-in-providers/${provider.id}`, headers: admin.headers });
    expect((await remove()).statusCode).toBe(409);

    const projects = app.get(ProjectService);
    await projects.updateAuth(first.projectId, first.envId, { mode: 'public' }, tenant.tenantId);
    await projects.updateAuth(second.projectId, second.envId, { mode: 'public' }, tenant.tenantId);
    const deleted = await remove();
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(auth.callsTo('removeSignInHost').at(-1)?.args).toEqual({ providerId: provider.id });
  });
});
