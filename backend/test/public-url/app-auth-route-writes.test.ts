import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomDomainCluster } from '../../src/custom-domain/custom-domain-cluster';
import { AppAuthRouteReconciler } from '../../src/project/app-auth-route.reconciler';
import { ProjectAuthService } from '../../src/project/project-auth.service';
import type { ProjectEnvironmentService } from '../../src/project-environment/project-environment.service';
import { createDomainTestingModule, type DomainTestHarness } from '../support/domain';
import type { FakeProjectAuthService } from '../support/infra-fakes';

const NO_CUSTOM_DOMAINS = {
  routedEnvironmentIds: () => Promise.resolve([]),
} as unknown as CustomDomainCluster;

let harness: DomainTestHarness;
let appAuth: FakeProjectAuthService;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  appAuth = harness.moduleRef.get<typeof ProjectAuthService, FakeProjectAuthService>(ProjectAuthService);
});

afterAll(async () => {
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
    const callsBeforeStart = appAuth.calls.length;

    await new AppAuthRouteReconciler(
      harness.projectEnvironments,
      appAuth as unknown as ProjectAuthService,
      NO_CUSTOM_DOMAINS
    ).reconcileAll();

    const reconciled = appAuth.callsTo('reconcileRoute').map((call) => call.args);
    expect(appAuth.calls[callsBeforeStart].method).toBe('writeIdentityHeaderStrip');
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
      appAuth as unknown as ProjectAuthService,
      NO_CUSTOM_DOMAINS
    ).reconcileAll();

    const reconciled = appAuth.callsTo('reconcileRoute').map((call) => call.args.environmentId);
    expect(reconciled).toContain(second.projectId);
  });

  it('removes a gate left on a public environment and keeps the gate of a protected one', async () => {
    const leftBehind = await newProject();
    const gated = await newProject();
    await harness.projects.updateAuth(
      gated.projectId,
      gated.projectId,
      { mode: 'manual', config: oidc },
      gated.tenantId
    );
    appAuth.setGate(leftBehind.projectId, { mode: 'manual', config: oidc, bypassAuthPaths: [] });

    await new AppAuthRouteReconciler(
      harness.projectEnvironments,
      appAuth as unknown as ProjectAuthService,
      NO_CUSTOM_DOMAINS
    ).reconcileAll();

    const removed = appAuth.callsTo('remove').map((call) => call.args.environmentId);
    expect(removed).toContain(leftBehind.projectId);
    expect(removed).not.toContain(gated.projectId);
  });
});

describe('App Auth routes are reconciled again once the replicas a rollout replaces are gone', () => {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const protectedEnvironment = { id: '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f', shortId: '3f2a9c1e7b4d' };

  function startedReconciler(): AppAuthRouteReconciler {
    const environments = {
      listProtected: () => Promise.resolve([protectedEnvironment]),
      findByIdOrNull: () => Promise.resolve({ authMode: 'manual' }),
    };
    const reconciler = new AppAuthRouteReconciler(
      environments as unknown as ProjectEnvironmentService,
      appAuth as unknown as ProjectAuthService,
      NO_CUSTOM_DOMAINS
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
