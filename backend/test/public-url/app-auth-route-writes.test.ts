import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db';
import { tenantSettings } from '../../db/schema';
import { ManagedAuthSyncProcessor } from '../../src/private/tenant-settings/managed-auth-sync.processor';
import type { ManagedAuthSyncJobData } from '../../src/private/tenant-settings/tenant-settings.types';
import { AppAuthRouteReconciler } from '../../src/project/app-auth-route.reconciler';
import { ProjectAuthService } from '../../src/project/project-auth.service';
import type { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import type { FakeProjectAuthService } from '../support/infra-fakes';

let harness: DomainTestHarness;
let appAuth: FakeProjectAuthService;

beforeAll(async () => {
  process.env.MANAGED_OIDC_CLIENT_SECRET = 'managed-secret';
  process.env.MANAGED_OIDC_ISSUER_URL = 'https://keycloak.example/realms/opsiforce';
  harness = await createDomainTestingModule();
  appAuth = harness.moduleRef.get<typeof ProjectAuthService, FakeProjectAuthService>(ProjectAuthService);
});

afterAll(async () => {
  delete process.env.MANAGED_OIDC_CLIENT_SECRET;
  delete process.env.MANAGED_OIDC_ISSUER_URL;
  await harness.close();
});

beforeEach(() => {
  appAuth.calls.length = 0;
});

async function newProject(): Promise<{ tenantId: string; projectId: string }> {
  const tenant = await harness.tenants.getOrCreateTenant(`app-auth-routes-${Date.now()}-${Math.random()}`);
  const project = await harness.projects.create({ title: 'Ledger' }, tenant.id);
  return { tenantId: tenant.id, projectId: project.id };
}

async function addressesOf(environmentId: string) {
  const env = await harness.projectEnvironments.findById(environmentId);
  return { environmentId: env.id, shortId: env.shortId };
}

const oidc = { clientId: 'client', clientSecret: 'secret', discoveryUrl: 'https://issuer.example' };

describe('the managed-auth fan-out', () => {
  it("re-applies a renamed tenant's App Auth for every address of the App", async () => {
    const { tenantId, projectId } = await newProject();
    await harness.projects.updateAuth(projectId, projectId, { mode: 'managed' }, tenantId);
    await db
      .update(tenantSettings)
      .set({ externalTenantName: 'example-org' })
      .where(eq(tenantSettings.tenantId, tenantId));
    appAuth.calls.length = 0;

    await new ManagedAuthSyncProcessor(appAuth as unknown as ProjectAuthService).process({
      data: { projectId, externalTenantName: 'example-org' },
    } as Job<ManagedAuthSyncJobData>);

    expect(appAuth.callsTo('applyManaged').map((call) => call.args)).toEqual([await addressesOf(projectId)]);
  });
});

describe('App Auth routes are reconciled at backend start', () => {
  it('for every protected environment and no public one', async () => {
    const protectedApp = await newProject();
    const publicApp = await newProject();
    await harness.projects.updateAuth(
      protectedApp.projectId,
      protectedApp.projectId,
      { mode: 'manual', config: oidc },
      protectedApp.tenantId
    );

    await new AppAuthRouteReconciler(
      harness.projectEnvironments,
      appAuth as unknown as ProjectAuthService
    ).reconcileAll();

    const reconciled = appAuth.callsTo('reconcileRoute').map((call) => call.args);
    expect(reconciled).toContainEqual(await addressesOf(protectedApp.projectId));
    expect(reconciled.map((args) => args.environmentId)).not.toContain(publicApp.projectId);
  });

  it('keeps going past an environment whose route cannot be reconciled', async () => {
    const first = await newProject();
    const second = await newProject();
    for (const { tenantId, projectId } of [first, second]) {
      await harness.projects.updateAuth(projectId, projectId, { mode: 'manual', config: oidc }, tenantId);
    }
    appAuth.failReconcileFor(first.projectId);

    await new AppAuthRouteReconciler(
      harness.projectEnvironments,
      appAuth as unknown as ProjectAuthService
    ).reconcileAll();

    const reconciled = appAuth.callsTo('reconcileRoute').map((call) => call.args.environmentId);
    expect(reconciled).toContain(second.projectId);
  });
});

describe('App Auth routes are reconciled again once the replicas a rollout replaces are gone', () => {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const protectedEnvironment = { id: '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f', shortId: '3f2a9c1e7b4d' };

  function startedReconciler(): AppAuthRouteReconciler {
    const environments = { listProtected: () => Promise.resolve([protectedEnvironment]) };
    const reconciler = new AppAuthRouteReconciler(
      environments as unknown as ProjectEnvironmentService,
      appAuth as unknown as ProjectAuthService
    );
    reconciler.onApplicationBootstrap();
    return reconciler;
  }

  function passes(): number {
    return appAuth.callsTo('reconcileRoute').filter((call) => call.args.environmentId === protectedEnvironment.id)
      .length;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('with one more pass five minutes after start, and no further one', async () => {
    const reconciler = startedReconciler();

    await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(passes()).toBe(2);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(passes()).toBe(2);
    reconciler.onModuleDestroy();
  });

  it('unless the backend stops first', async () => {
    const reconciler = startedReconciler();
    await vi.advanceTimersByTimeAsync(0);

    reconciler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES);

    expect(passes()).toBe(1);
  });
});
